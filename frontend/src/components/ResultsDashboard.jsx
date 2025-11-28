import React, { useState, useMemo } from "react";
import {
  PieChart,
  FileText,
  Filter,
  ExternalLink,
  ChevronLeft,
  ChevronRight,
  Building2,
  Calendar,
  AlertTriangle
} from "lucide-react";
import SimpleDonutChart from "./SimpleDonutChart";

function formatCurrency(value) {
  if (!value || isNaN(value)) return "N/A";
  return (
    "$" +
    Number(value).toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    })
  );
}

function formatNumber(value) {
  if (!value || isNaN(value)) return "N/A";
  return Number(value).toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0
  });
}

export default function ResultsDashboard({ data }) {
  const [filterText, setFilterText] = useState("");
  const [sortConfig, setSortConfig] = useState({
    key: "title",
    direction: "asc"
  });
  const [currentPage, setCurrentPage] = useState(1);
  const [selectedFilingIndex, setSelectedFilingIndex] = useState(0);
  const itemsPerPage = 10;

  if (!data) return null;

  if (
    data.error ||
    data.status === "not_found" ||
    data.status === "known_issue"
  ) {
    return (
      <div className="rounded-lg bg-yellow-50 border border-yellow-200 p-6 animate-fade-in">
        <div className="flex items-start">
          <AlertTriangle className="h-6 w-6 text-yellow-600 flex-shrink-0" />
          <div className="ml-4">
            <h3 className="text-base font-semibold text-yellow-900 mb-2">
              Data Unavailable
            </h3>
            <p className="text-sm text-yellow-800">
              {data.error || data.message || "Unable to display holdings data"}
            </p>
          </div>
        </div>
      </div>
    );
  }

  const filingGroups = data.filing_groups || [];
  const hasMultipleFilings = filingGroups.length > 1;

  const activeFiling = filingGroups.length > 0
    ? filingGroups[selectedFilingIndex]
    : {
      form: data.form_type,
      series_name: "Series A",
      accession_number: data.accession_number,
      filing_url: data.filing_url,
      filing_date: data.filing_date,
      holdings_count: data.holdings_count,
      total_assets: data.total_assets,
      holdings: data.holdings || []
    };

  const holdings = activeFiling.holdings || [];

  const filteredHoldings = useMemo(() => {
    if (holdings.length === 0) return [];
    const term = filterText.toLowerCase();
    return holdings.filter(
      (h) =>
        (h.title && h.title.toLowerCase().includes(term)) ||
        (h.cusip && h.cusip.toLowerCase().includes(term))
    );
  }, [holdings, filterText]);

  const sortedHoldings = useMemo(() => {
    if (!filteredHoldings || filteredHoldings.length === 0) return [];
    const sorted = [...filteredHoldings].sort((a, b) => {
      const aValue = a[sortConfig.key];
      const bValue = b[sortConfig.key];

      if (typeof aValue === "string") {
        return (aValue || "").localeCompare(bValue || "");
      }
      return (aValue || 0) - (bValue || 0);
    });
    if (sortConfig.direction === "desc") sorted.reverse();
    return sorted;
  }, [filteredHoldings, sortConfig]);

  const paginatedData = useMemo(() => {
    const start = (currentPage - 1) * itemsPerPage;
    return sortedHoldings.slice(start, start + itemsPerPage);
  }, [sortedHoldings, currentPage]);

  const totalPages = Math.ceil(sortedHoldings.length / itemsPerPage);

  const requestSort = (key) => {
    let direction = "asc";
    if (sortConfig.key === key && sortConfig.direction === "asc") {
      direction = "desc";
    }
    setSortConfig({ key, direction });
    setCurrentPage(1);
  };

  const handlePageChange = (page) => {
    if (page < 1 || page > totalPages) return;
    setCurrentPage(page);
  };

  const SortIcon = ({ columnKey }) => {
    if (sortConfig.key !== columnKey) return null;
    return (
      <span className="ml-1 text-blue-600 font-bold">
        {sortConfig.direction === "asc" ? "▲" : "▼"}
      </span>
    );
  };

  const handleFilingChange = (idx) => {
    setSelectedFilingIndex(idx);
    setCurrentPage(1);
    setFilterText("");
  };

  const [selectedSeries, setSelectedSeries] = useState("all");


  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header with Fund Name */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <div className="flex items-center text-sm text-gray-500 mb-1">
              <Building2 className="w-4 h-4 mr-1.5" />
              Fund / Registrant
            </div>
            <h1 className="text-2xl font-bold text-gray-900 leading-tight">
              {data.registrant_name || "Unknown Fund Entity"}
            </h1>
            <p className="text-sm text-gray-500 mt-1">CIK: {data.cik}</p>
          </div>

          <div className="flex flex-col items-end space-y-2">
            <div className="flex items-center text-sm text-gray-500">
              <Calendar className="w-4 h-4 mr-1.5" />
              Filing Date
            </div>
            <div className="text-lg font-semibold text-gray-900">
              {activeFiling.filing_date || data.latest_date || "N/A"}
            </div>
          </div>
        </div>

        {/* Tabs for Multiple Series */}
        {hasMultipleFilings && (
          <div className="mt-6 border-t border-gray-200 pt-4">
            <div className="flex items-center mb-3">
              <FileText className="w-4 h-4 text-gray-400 mr-2" />
              <span className="text-sm font-medium text-gray-700">Multiple Series Available</span>
            </div>
            <div className="flex flex-wrap gap-2">
              {filingGroups.map((filing, idx) => (
                <button
                  key={filing.accession_number}
                  onClick={() => handleFilingChange(idx)}
                  className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${selectedFilingIndex === idx
                    ? "bg-blue-600 text-white shadow-md"
                    : "bg-gray-100 text-gray-700 hover:bg-gray-200"
                    }`}
                >
                  {filing.series_name || `Series ${idx + 1}`}
                </button>
              ))}
            </div>
          </div>
        )}

        {hasMultipleFilings && (
          <div className="mt-6 border-t border-gray-200 pt-4">
            <div className="flex items-center mb-3">
              <FileText className="w-4 h-4 text-gray-400 mr-2" />
              <span className="text-sm font-medium text-gray-700">
                Select Series
              </span>
            </div>

            <div className="w-full sm:w-80">
              <select
                className="block w-full pl-3 pr-10 py-2 text-sm border border-gray-300 bg-white rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
                value={selectedFilingIndex}
                onChange={(e) => handleFilingChange(Number(e.target.value))}
              >
                {filingGroups.map((filing, idx) => (
                  <option key={filing.accession_number} value={idx}>
                    {filing.series_name || `Series ${idx + 1}`}
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}

      </div>

      {/* Warning if no holdings */}
      {holdings.length === 0 && (
        <div className="rounded-lg bg-yellow-50 border border-yellow-200 p-4">
          <div className="flex">
            <AlertTriangle className="h-5 w-5 text-yellow-600 flex-shrink-0" />
            <div className="ml-3">
              <h3 className="text-sm font-medium text-yellow-800">
                No Holdings Data
              </h3>
              <div className="mt-1 text-sm text-yellow-700">
                The filing was retrieved but contains no portfolio holdings. This
                may indicate an empty fund or a filing error.
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Stats Row */}
      {holdings.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {/* Asset Allocation Chart Card */}
          <div className="md:col-span-2 bg-white rounded-xl shadow-sm border border-gray-200 p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-gray-900 flex items-center">
                <PieChart className="w-5 h-5 mr-2 text-gray-400" />
                Top Holdings Allocation
              </h3>
              <span className="text-xs font-mono text-gray-400">
                By Market Value
              </span>
            </div>
            <SimpleDonutChart
              data={holdings.map((h) => ({ ...h, name: h.title }))}
            />
          </div>

          {/* Summary Metrics Card */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 flex flex-col justify-between">
            <div>
              <h3 className="text-sm font-medium text-gray-500 uppercase tracking-wide mb-4">
                Portfolio Summary
              </h3>
              <dl className="space-y-4">
                <div>
                  <dt className="text-xs text-gray-400">Series Name</dt>
                  <dd className="text-lg font-bold text-blue-600 mt-1">
                    {activeFiling.series_name || "Series A"}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-gray-400">
                    Total Net Assets (Est.)
                  </dt>
                  <dd className="text-2xl font-bold text-gray-900">
                    {formatCurrency(activeFiling.total_assets)}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-gray-400">Total Positions</dt>
                  <dd className="text-xl font-medium text-gray-900">
                    {formatNumber(activeFiling.holdings_count)}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-gray-400">Accession Number</dt>
                  <dd
                    className="text-sm font-mono text-gray-600 truncate"
                    title={activeFiling.accession_number}
                  >
                    {activeFiling.accession_number || "N/A"}
                  </dd>
                </div>
              </dl>
            </div>
            {activeFiling.filing_url && (
              <div className="pt-4 border-t border-gray-100 mt-4">
                <a
                  href={activeFiling.filing_url}
                  target="_blank"
                  rel="noreferrer"
                  className="w-full inline-flex items-center justify-center px-4 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 transition-colors"
                >
                  <ExternalLink className="w-4 h-4 mr-2" />
                  View Filing Source
                </a>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Main Table Card */}
      {holdings.length > 0 && (
        <div
          id="holdings-table"
          className="bg-white shadow-sm rounded-xl border border-gray-200 flex flex-col overflow-hidden"
        >
          {/* Table Controls */}
          <div className="p-4 border-b border-gray-200 bg-gray-50/50 flex flex-col sm:flex-row justify-between items-center gap-4">
            <div className="flex items-center">
              <FileText className="w-5 h-5 text-gray-400 mr-2" />
              <h3 className="text-lg font-medium text-gray-900">
                Holdings Detail
              </h3>
            </div>

            {/* Filter Input */}
            <div className="relative w-full sm:w-72">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                <Filter className="h-4 w-4 text-gray-400" />
              </div>
              <input
                type="text"
                value={filterText}
                onChange={(e) => setFilterText(e.target.value)}
                placeholder="Filter by name or CUSIP..."
                className="block w-full pl-9 pr-3 py-2 border border-gray-300 rounded-md leading-5 bg-white placeholder-gray-400 focus:outline-none focus:placeholder-gray-300 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 sm:text-sm transition-shadow"
              />
            </div>
          </div>

          {/* Desktop Table View */}
          <div className="hidden md:block overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50 text-xs uppercase font-medium text-gray-500 tracking-wider">
                <tr>
                  <th
                    scope="col"
                    className="px-6 py-3 text-left cursor-pointer hover:bg-gray-100 transition-colors group"
                    onClick={() => requestSort("title")}
                  >
                    <div className="flex items-center">
                      Investment Name
                      <SortIcon columnKey="title" />
                    </div>
                  </th>
                  <th
                    scope="col"
                    className="px-6 py-3 text-left cursor-pointer hover:bg-gray-100 transition-colors group"
                    onClick={() => requestSort("cusip")}
                  >
                    <div className="flex items-center">
                      CUSIP
                      <SortIcon columnKey="cusip" />
                    </div>
                  </th>
                  <th
                    scope="col"
                    className="px-6 py-3 text-right cursor-pointer hover:bg-gray-100 transition-colors group"
                    onClick={() => requestSort("balance")}
                  >
                    <div className="flex items-center justify-end text-blue-700">
                      Balance (Shares)
                      <SortIcon columnKey="balance" />
                    </div>
                  </th>
                  <th
                    scope="col"
                    className="px-6 py-3 text-right cursor-pointer hover:bg-gray-100 transition-colors group"
                    onClick={() => requestSort("value")}
                  >
                    <div className="flex items-center justify-end">
                      Value (USD)
                      <SortIcon columnKey="value" />
                    </div>
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {paginatedData.length > 0 ? (
                  paginatedData.map((holding, index) => (
                    <tr
                      key={index}
                      className="hover:bg-blue-50/50 transition-colors"
                    >
                      <td className="px-6 py-4">
                        <div className="text-sm font-medium text-gray-900">
                          {holding.title || "N/A"}
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 font-mono">
                        {holding.cusip && holding.cusip !== "N/A" ? (
                          holding.cusip
                        ) : (
                          <span className="text-gray-300">-</span>
                        )}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 text-right font-mono font-medium">
                        {formatNumber(holding.balance)}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 text-right font-mono font-semibold text-blue-700">
                        {formatCurrency(holding.value)}
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td
                      colSpan="4"
                      className="px-6 py-10 text-center text-sm text-gray-500 bg-gray-50"
                    >
                      No holdings match your filter.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Mobile Card View */}
          <div className="md:hidden divide-y divide-gray-200">
            {paginatedData.length > 0 ? (
              paginatedData.map((holding, index) => (
                <div key={index} className="p-4 space-y-3 bg-white">
                  <div className="flex justify-between items-start gap-2">
                    <div className="font-medium text-gray-900 text-sm">
                      {holding.title || "N/A"}
                    </div>
                    {holding.cusip && holding.cusip !== "N/A" && (
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-800 font-mono">
                        {holding.cusip}
                      </span>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div className="bg-gray-50 p-2 rounded">
                      <span className="block text-xs text-gray-500 uppercase tracking-wide mb-1">
                        Balance
                      </span>
                      <span className="font-mono font-medium text-gray-900">
                        {formatNumber(holding.balance)}
                      </span>
                    </div>
                    <div className="bg-blue-50 p-2 rounded text-right">
                      <span className="block text-xs text-blue-500 uppercase tracking-wide mb-1">
                        Value
                      </span>
                      <span className="font-mono font-bold text-blue-700">
                        {formatCurrency(holding.value)}
                      </span>
                    </div>
                  </div>
                </div>
              ))
            ) : (
              <div className="p-8 text-center text-sm text-gray-500 bg-gray-50">
                No holdings match your filter.
              </div>
            )}
          </div>

          {/* Pagination Footer */}
          {totalPages > 0 && (
            <div className="px-4 py-3 border-t border-gray-200 bg-gray-50 flex items-center justify-between sm:px-6">
              <div className="flex-1 flex justify-between sm:hidden">
                <button
                  onClick={() => handlePageChange(currentPage - 1)}
                  disabled={currentPage === 1}
                  className="relative inline-flex items-center px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Previous
                </button>
                <button
                  onClick={() => handlePageChange(currentPage + 1)}
                  disabled={currentPage === totalPages}
                  className="ml-3 relative inline-flex items-center px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Next
                </button>
              </div>
              <div className="hidden sm:flex-1 sm:flex sm:items-center sm:justify-between">
                <div>
                  <p className="text-sm text-gray-700">
                    Showing{" "}
                    <span className="font-medium">
                      {(currentPage - 1) * itemsPerPage + 1}
                    </span>{" "}
                    to{" "}
                    <span className="font-medium">
                      {Math.min(
                        currentPage * itemsPerPage,
                        sortedHoldings.length
                      )}
                    </span>{" "}
                    of <span className="font-medium">{sortedHoldings.length}</span>{" "}
                    results
                  </p>
                </div>
                <div>
                  <nav
                    className="relative z-0 inline-flex rounded-md shadow-sm -space-x-px"
                    aria-label="Pagination"
                  >
                    <button
                      onClick={() => handlePageChange(currentPage - 1)}
                      disabled={currentPage === 1}
                      className="relative inline-flex items-center px-2 py-2 rounded-l-md border border-gray-300 bg-white text-sm font-medium text-gray-500 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <span className="sr-only">Previous</span>
                      <ChevronLeft className="h-5 w-5" aria-hidden="true" />
                    </button>
                    <div className="relative inline-flex items-center px-4 py-2 border border-gray-300 bg-white text-sm font-medium text-gray-700">
                      Page {currentPage} of {totalPages}
                    </div>
                    <button
                      onClick={() => handlePageChange(currentPage + 1)}
                      disabled={currentPage === totalPages}
                      className="relative inline-flex items-center px-2 py-2 rounded-r-md border border-gray-300 bg-white text-sm font-medium text-gray-500 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <span className="sr-only">Next</span>
                      <ChevronRight className="h-5 w-5" aria-hidden="true" />
                    </button>
                  </nav>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}