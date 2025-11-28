import { useEffect, useRef, useState } from "react";
import Navbar from "./components/Navbar";
import backendUrl from "./Config";

import { Database, ExternalLink, Loader2, Search, X, XCircle, Info } from "lucide-react";
import ResultsDashboard from "./components/ResultsDashboard";


function App() {
  const [cik, setCik] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadingProgress, setLoadingProgress] = useState(null);
  const [error, setError] = useState(null);
  const [rateLimitStats, setRateLimitStats] = useState(null);
  const [retryCountdown, setRetryCountdown] = useState(0);
  const eventSourceRef = useRef(null);
  const partialDataRef = useRef({ filingGroups: [], metadata: null });
  const countdownIntervalRef = useRef(null);
  const [taskId, setTaskId] = useState(null);
  const [cache, setCache] = useState(new Map());
  const [cacheStats, setCacheStats] = useState({ hits: 0, misses: 0, size: 0 });

  const normalizeCik = (cik) => cik.padStart(10, '0');

  const getFromCache = (cik) => cache.get(normalizeCik(cik));
  const setInCache = (cik, data) => {
    const newCache = new Map(cache);
    newCache.set(normalizeCik(cik), { ...data, cachedAt: Date.now() });
    setCache(newCache);
    setCacheStats({ hits: cacheStats.hits, misses: cacheStats.misses + 1, size: newCache.size });
  };


  const updateCacheAge = () => {
    if (cache.size > 0) {
      const now = Date.now();
      setCache(prevCache => {
        const newCache = new Map();
        let updatedStats = { hits: cacheStats.hits, misses: cacheStats.misses, size: 0 };

        for (let [cikKey, cachedData] of prevCache) {
          const age = Math.floor((now - cachedData.cachedAt) / (1000 * 60 * 60)); // Hours
          newCache.set(cikKey, { ...cachedData, cacheAge: age });
        }
        updatedStats.size = newCache.size;
        setCacheStats(updatedStats);
        return newCache;
      });
    }
  };



  // Fetch rate limit stats on mount and after actions
  const fetchRateLimitStats = async () => {
    try {
      const response = await fetch(`${backendUrl}/rate-limit/stats`);
      if (response.ok) {
        const stats = await response.json();
        setRateLimitStats(stats);

        // Handle frozen state from backend
        if (stats.frozen_until) {
          const now = Date.now();
          const frozenUntil = new Date(stats.frozen_until).getTime();
          if (frozenUntil > now) {
            const secondsLeft = Math.ceil((frozenUntil - now) / 1000);
            startCountdown(secondsLeft);
          }
        }
      }
    } catch (err) {
      console.error('Failed to fetch rate limit stats:', err);
    }
  };


  const startCountdown = (seconds) => {
    setRetryCountdown(seconds);
    if (countdownIntervalRef.current) clearInterval(countdownIntervalRef.current);

    countdownIntervalRef.current = setInterval(() => {
      setRetryCountdown(prev => {
        if (prev <= 1) {
          clearInterval(countdownIntervalRef.current);
          fetchRateLimitStats();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  };

  // Initial fetch
  useEffect(() => {
    fetchRateLimitStats();
    return () => {
      if (countdownIntervalRef.current) clearInterval(countdownIntervalRef.current);
    };
  }, []);

  const cancelStreaming = async () => {
    // 1. Cancel backend task
    if (taskId) {
      try {
        await fetch(`${backendUrl}/stream/${taskId}/cancel`, { method: 'POST' });
      } catch (err) {
        console.log('Cancel request failed:', err);
      }
    }

    // 2. Close EventSource
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }

    // 3. Show partial data
    if (partialDataRef.current.filingGroups.length > 0) {
      setData({
        ...partialDataRef.current.metadata,
        filing_groups: partialDataRef.current.filingGroups,
        processing_time: 'Cancelled by user'
      });
      setLoadingProgress(prev => ({
        ...prev,
        message: `Cancelled - Showing ${partialDataRef.current.filingGroups.length} series`
      }));
    }

    setLoading(false);
    setTaskId(null);
    fetchRateLimitStats();
  };

  const fetchHoldings = async () => {
    const trimmedCik = cik.trim();
    if (!trimmedCik) {
      setError({
        type: 'validation',
        title: 'Invalid Input',
        message: 'Please enter a valid CIK number',
        suggestions: [
          'CIK must be a numeric value',
          'Example: 0000884394'
        ]
      });
      return;
    }

    // Check cache first
    const cachedData = getFromCache(trimmedCik);
    if (cachedData) {
      console.log('🎯 CACHE HIT');
      setCacheStats(prev => ({ ...prev, hits: prev.hits + 1 }));
      setData({ ...cachedData, fromCache: true });
      setLoading(false);
      setError(null);
      setLoadingProgress(null);
      return;
    }

    // Cache miss
    console.log('📡 CACHE MISS');
    setCacheStats(prev => ({ ...prev, misses: prev.misses + 1 }));

    // Close existing EventSource connection if any
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    setLoading(true);
    setError(null);
    setData(null);
    setLoadingProgress(null);
    partialDataRef.current = { filingGroups: [], metadata: null };

    try {
      const taskId = crypto.randomUUID();
      setTaskId(taskId);
      const streamUrl = `${backendUrl}/holdings/${trimmedCik}/stream?task_id=${taskId}`;

      const eventSource = new EventSource(streamUrl);
      eventSourceRef.current = eventSource;

      eventSource.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);

          switch (message.type) {
            case 'metadata':
              partialDataRef.current.metadata = {
                registrant_name: message.registrant_name,
                latest_date: message.latest_date,
                cik: trimmedCik
              };
              setLoadingProgress({
                current: 0,
                total: message.total_filings,
                message: `Found ${message.total_filings} series to process...`,
                investmentsFound: 0
              });
              break;

            case 'progress':
              setLoadingProgress(prev => ({
                ...prev,
                current: message.current,
                total: message.total,
                message: `Processing series ${message.current} of ${message.total}...`
              }));
              break;

            case 'series':
              partialDataRef.current.filingGroups.push(message.data);
              setData({
                ...partialDataRef.current.metadata,
                filing_groups: [...partialDataRef.current.filingGroups],
                processing_time: 'In progress...'
              });
              setLoadingProgress(prev => ({
                ...prev,
                investmentsFound: (prev?.investmentsFound || 0) + message.data.holdings_count,
                message: `Processing series ${prev.current} of ${prev.total}... (${(prev?.investmentsFound || 0) + message.data.holdings_count} investments found)`
              }));
              break;

            case 'warning':
              console.warn('Series warning:', message.message);
              break;

            case 'error':
              console.error('Backend error:', message.message);
              setError({
                type: 'backend_error',
                title: message.status_code === 404 ? 'CIK Not Found' : 'Server Error',
                message: message.message || 'An error occurred while processing',
                status_code: message.status_code,
                cik: trimmedCik,
                registrant_name: partialDataRef.current.metadata?.registrant_name,
                suggestions: [
                  ...(message.status_code === 404 ? [
                    'CIK does not exist in SEC database',
                    'Fund may not file N-PORT reports'
                  ] : [
                    'Server temporarily unavailable',
                    'Try again in a few moments'
                  ]),
                  'Check SEC EDGAR directly',
                  `Status: ${message.status_code || 'Unknown'}`
                ]
              });
              setLoading(false);
              if (eventSourceRef.current) {
                eventSourceRef.current.close();
              }
              fetchRateLimitStats();
              break;

            case 'complete':
              setLoadingProgress(prev => ({
                ...prev,
                current: message.total_processed,
                total: message.total_processed,
                message: `Completed in ${message.processing_time} - ${prev?.investmentsFound || 0} total investments`
              }));

              if (partialDataRef.current.filingGroups.length > 0) {
                const finalData = {
                  ...partialDataRef.current.metadata,
                  filing_groups: partialDataRef.current.filingGroups,
                  processing_time: message.processing_time,
                  fetchedAt: Date.now()
                };
                setInCache(trimmedCik, finalData); // Cache the final data

                setData(finalData);
              } else {
                setError({
                  type: 'no_data',
                  title: 'No Holdings Found',
                  message: 'No N-PORT holdings data found for this CIK',
                  cik: trimmedCik,
                  registrant_name: partialDataRef.current.metadata?.registrant_name,
                  suggestions: [
                    'This fund may not file N-PORT reports',
                    'The latest filing may be empty',
                    'Try a different CIK'
                  ]
                });
              }

              setLoading(false);
              eventSource.close();
              fetchRateLimitStats();
              break;

            default:
              console.log('Unknown message type:', message.type);
          }
        } catch (err) {
          console.error('Error parsing SSE message:', err);
        }
      };

      eventSource.onerror = (err) => {
        console.error('EventSource error:', err);

        if (partialDataRef.current.filingGroups.length > 0) {
          setData({
            ...partialDataRef.current.metadata,
            filing_groups: partialDataRef.current.filingGroups,
            processing_time: 'Partial (connection interrupted)'
          });
        } else {
          if (eventSourceRef.current?.readyState === EventSource.CLOSED) {
            // Try to fetch error details from backend for better message
            fetch(`${backendUrl}/holdings/${trimmedCik}`)
              .then(response => {
                if (!response.ok) {
                  return response.json().catch(() => ({}));
                }
                return response.json();
              })
              .then(errorData => {
                setError({
                  type: 'backend_error',
                  title: errorData.status_code === 404 ? 'CIK Not Found' : 'Server Error',
                  message: errorData.detail || 'Invalid CIK or server error',
                  status_code: errorData.status_code || response.status,
                  cik: trimmedCik,
                  suggestions: [
                    ...(errorData.status_code === 404 || response.status === 404 ? [
                      'CIK does not exist in SEC database',
                      'Fund may not file N-PORT reports'
                    ] : [
                      'Server temporarily unavailable',
                      'Try again in a few moments'
                    ]),
                    'Check SEC EDGAR directly',
                    `Status: ${errorData.status_code || response.status}`
                  ]
                });
              })
              .catch(() => {
                setError({
                  type: 'network',
                  title: 'Connection Error',
                  message: 'Lost connection to server while streaming data',
                  suggestions: [
                    'Check your internet connection',
                    'The server may be temporarily unavailable',
                    'Try again in a few moments'
                  ]
                });
              });
          } else {
            setError({
              type: 'Error',
              title: 'Input / Connection Error',
              message: 'Kindly submit a valid cik no.',
              // suggestions: [
              //   'Check your internet connection',
              //   'The server may be temporarily unavailable',
              //   'Try again in a few moments'
              // ]
            });
          }
        }

        setLoading(false);
        if (eventSourceRef.current) {
          eventSourceRef.current.close();
        }
        fetchRateLimitStats();
      };
    } catch (err) {
      console.error('Fetch error:', err);
      setError({
        type: 'network',
        title: 'Network Error',
        message: 'Unable to connect to the server',
        suggestions: [
          'Check your internet connection',
          'The server may be temporarily unavailable',
          'Try again in a few moments'
        ]
      });
      setLoading(false);
      fetchRateLimitStats();
    }
  };


  const handleKeyPress = (e) => {
    if (e.key === 'Enter' && !loading && retryCountdown === 0) fetchHoldings();
  };

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 font-sans">
      <Navbar />

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">

        {/* Search Section */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 mb-8 transition-all hover:shadow-md">
          <div className="flex justify-between items-center mb-2">
            <label className="block text-sm font-semibold text-gray-700">
              Search SEC EDGAR Database
            </label>
            {rateLimitStats && (
              <div className="text-xs font-mono text-gray-500 flex items-center gap-3 p-2 bg-gray-100 rounded-lg">
                <span className="text-xs">
                  Min: {rateLimitStats.remaining_minute}/{rateLimitStats.limit_minute}
                  <span className={rateLimitStats.remaining_minute <= 2 ? "text-red-600 font-bold ml-1" : "ml-1"}>
                    ({rateLimitStats.requests_last_minute}/min)
                  </span>
                </span>
                <span>•</span>
                <span>
                  Hr: {rateLimitStats.remaining_hour}/{rateLimitStats.limit_hour}
                </span>
                {retryCountdown > 0 && (
                  <span className="text-red-600 font-bold animate-pulse ml-2">
                    ⏱️ {retryCountdown}s
                  </span>
                )}
              </div>
            )}


          </div>
          <div className="flex flex-col sm:flex-row gap-4">
            <div className="relative flex-1">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                <Search className="h-5 w-5 text-gray-400" />
              </div>
              <input
                type="text"
                value={cik}
                onChange={(e) => setCik(e.target.value)}
                onKeyPress={handleKeyPress}
                placeholder="Enter Fund CIK (e.g., 0000884394)"
                disabled={loading || retryCountdown > 0}
                className={`block w-full pl-10 rounded-lg border-gray-300 border bg-gray-50 focus:bg-white focus:ring-2 focus:ring-blue-500 focus:border-transparent py-3 transition-colors ${retryCountdown > 0 ? 'opacity-50 cursor-not-allowed' : ''}`}
              />
            </div>
            <button
              onClick={fetchHoldings}
              disabled={loading || !cik.trim() || retryCountdown > 0}
              className={`inline-flex items-center justify-center px-6 py-3 border border-transparent text-sm font-medium rounded-lg text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed shadow-sm min-w-[140px] ${retryCountdown > 0 ? 'bg-gray-400 hover:bg-gray-400' : ''}`}
            >
              {loading ? (
                <>
                  <Loader2 className="animate-spin -ml-1 mr-2 h-4 w-4" />
                  Streaming...
                </>
              ) : retryCountdown > 0 ? (
                `Wait ${retryCountdown}s`
              ) : (
                'Analyze Fund'
              )}
            </button>
          </div>

          <div className="mt-4 flex flex-wrap gap-2 items-center text-sm text-gray-500">
            <span className="text-xs uppercase tracking-wide font-semibold text-gray-400">Quick Load:</span>
            {['884394', '1592900', '1742952', '0001485894 '].map((exampleCik) => (
              <button
                key={exampleCik}
                onClick={() => setCik(exampleCik)}
                disabled={loading || retryCountdown > 0}
                className="px-3 py-1 bg-white border border-gray-200 hover:border-blue-300 hover:text-blue-600 text-gray-600 rounded-full text-xs font-mono transition-all disabled:opacity-50"
              >
                {exampleCik}
              </button>
            ))}
          </div>
        </div>

        {/* Loading Progress Indicator */}
        {loading && loadingProgress && (
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-6 mb-8 animate-fade-in">
            <div className="flex items-start gap-3">
              <Loader2 className="animate-spin h-5 w-5 text-blue-600 mt-0.5 flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-medium text-blue-900">
                    {loadingProgress.message}
                  </span>
                  <span className="text-xs font-mono text-blue-700">
                    {loadingProgress.current}/{loadingProgress.total}
                  </span>
                </div>
                <div className="w-full bg-blue-200 rounded-full h-2 mb-3">
                  <div
                    className="bg-blue-600 h-2 rounded-full transition-all duration-300"
                    style={{
                      width: `${(loadingProgress.current / loadingProgress.total) * 100}%`
                    }}
                  ></div>
                </div>
                {loadingProgress.investmentsFound > 0 && (
                  <p className="text-xs text-blue-700">
                    📊 {loadingProgress.investmentsFound.toLocaleString()} investments discovered so far
                  </p>
                )}
              </div>
              <button
                onClick={cancelStreaming}
                className="flex-shrink-0 inline-flex items-center px-3 py-1.5 border border-blue-300 text-xs font-medium rounded-md text-blue-700 bg-white hover:bg-blue-100 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 transition-colors"
              >
                <X className="h-3 w-3 mr-1" />
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Error Display */}
        {error && (
          <div className={`rounded-lg border p-6 mb-8 animate-fade-in ${error.type === 'rate_limit' ? 'bg-orange-50 border-orange-200' :
            error.type === 'validation' ? 'bg-yellow-50 border-yellow-200' :
              'bg-red-50 border-red-200'
            }`}>
            <div className="flex items-start">
              <div className="flex-shrink-0">
                <XCircle className={`h-6 w-6 ${error.type === 'rate_limit' ? 'text-orange-600' :
                  error.type === 'validation' ? 'text-yellow-600' :
                    'text-red-600'
                  }`} />
              </div>
              <div className="ml-4 flex-1">
                <h3 className={`text-base font-semibold mb-2 ${error.type === 'rate_limit' ? 'text-orange-900' :
                  error.type === 'validation' ? 'text-yellow-900' :
                    'text-red-900'
                  }`}>
                  {error.title}
                </h3>
                <p className={`text-sm mb-4 ${error.type === 'rate_limit' ? 'text-orange-800' :
                  error.type === 'validation' ? 'text-yellow-800' :
                    'text-red-800'
                  }`}>
                  {error.message}
                </p>

                {/* Show fund details if available */}
                {(error.cik || error.registrant_name) && (
                  <div className="bg-white rounded-md border border-gray-200 p-4 mb-4">
                    <h4 className="text-xs font-semibold text-gray-700 uppercase tracking-wide mb-2">
                      Fund Details
                    </h4>
                    <dl className="space-y-1 text-sm">
                      {error.cik && (
                        <div>
                          <dt className="inline font-medium text-gray-700">CIK: </dt>
                          <dd className="inline text-gray-600 font-mono">{error.cik}</dd>
                        </div>
                      )}
                      {error.registrant_name && (
                        <div>
                          <dt className="inline font-medium text-gray-700">Registrant: </dt>
                          <dd className="inline text-gray-600">{error.registrant_name}</dd>
                        </div>
                      )}
                    </dl>
                  </div>
                )}

                {/* Suggestions */}
                {error.suggestions && error.suggestions.length > 0 && (
                  <div className="bg-white rounded-md border border-gray-200 p-4 mb-4">
                    <div className="flex items-center mb-2">
                      <Info className="h-4 w-4 text-blue-600 mr-2" />
                      <h4 className="text-xs font-semibold text-gray-700 uppercase tracking-wide">
                        Suggestions
                      </h4>
                    </div>
                    <ul className="list-disc list-inside space-y-1 text-sm text-gray-700">
                      {error.suggestions.map((suggestion, idx) => (
                        <li key={idx}>{suggestion}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* SEC.gov Link */}
                {cik.trim() && error.type !== 'validation' && (
                  <div className="mt-4">
                    <a
                      href={`https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik.trim()}&type=NPORT-P&dateb=&owner=exclude&count=100`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center text-sm font-medium text-blue-700 hover:text-blue-800"
                    >
                      <ExternalLink className="h-4 w-4 mr-1" />
                      Search this CIK on SEC.gov
                    </a>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Empty State */}
        {!data && !loading && !error && (
          <div className="text-center py-24 bg-white rounded-xl border-2 border-dashed border-gray-200">
            <div className="bg-gray-50 w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4">
              <Database className="h-8 w-8 text-gray-400" />
            </div>
            <h3 className="text-base font-semibold text-gray-900">No Data Loaded</h3>
            <p className="mt-1 text-sm text-gray-500 max-w-sm mx-auto">
              Enter a Central Index Key (CIK) above to access real-time N-PORT holdings data directly from the SEC.
            </p>
            <div className="mt-6">
              <a
                href="https://www.sec.gov/edgar/searchedgar/companysearch.html"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center text-sm font-medium text-blue-600 hover:text-blue-700"
              >
                <ExternalLink className="h-4 w-4 mr-1" />
                Find CIK numbers on SEC.gov
              </a>
            </div>
          </div>
        )}

        {/* Results Dashboard */}
        {data && <ResultsDashboard data={data} />}
      </main>
    </div>
  );
}

export default App;