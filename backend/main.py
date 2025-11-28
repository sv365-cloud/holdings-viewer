from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
import requests
from bs4 import BeautifulSoup
from functools import lru_cache
import logging
from typing import List, Dict, Optional
import time
import math
import json
import asyncio
from collections import defaultdict
from datetime import datetime, timedelta
from contextlib import asynccontextmanager
import signal
import uuid



# Setup basic logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Initialize FastAPI app
app = FastAPI(title="SEC N-PORT Viewer")
active_tasks = {}


# Configure CORS to allow frontend access
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# SEC requires proper headers for API access
SEC_HEADERS = {
    "User-Agent": "NPortViewer/1.0 contact@example.com",
    "Accept-Encoding": "gzip, deflate",
    "Accept-Language": "en-US,en;q=0.9",
}

# Create reusable session for better performance
session = requests.Session()
session.headers.update(SEC_HEADERS)

# All valid N-PORT form types
NPORT_FORMS = {"NPORT-P", "NPORT-P/A", "NPORT-NRT", "NPORT-NRT/A"}


# WRONG (line ~94):
requests_per_minute=10,
requests_per_hour=100


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup
    yield
    # Shutdown - cleanup tasks
    for task_id in list(active_tasks.keys()):
        if task_id in active_tasks:
            active_tasks[task_id].cancel()
    active_tasks.clear()
app.router.lifespan_context = lifespan



class RateLimiter:
    def __init__(self, requests_per_minute: int = 10, requests_per_hour: int = 100):
        self.requests_per_minute = requests_per_minute
        self.requests_per_hour = requests_per_hour
        self.minute_requests = defaultdict(list)
        self.hour_requests = defaultdict(list)
    
    def is_allowed(self, ip: str) -> tuple[bool, Optional[str]]:
        """
        Check if this IP can make another request.
        Returns (allowed, error_message)
        """
        current_time = datetime.now()
        
        # Calculate cutoff times
        one_hour_ago = current_time - timedelta(hours=1)
        one_minute_ago = current_time - timedelta(minutes=1)
        
        # Clean up old request timestamps
        self.minute_requests[ip] = [
            timestamp for timestamp in self.minute_requests[ip]
            if timestamp > one_minute_ago
        ]
        
        self.hour_requests[ip] = [
            timestamp for timestamp in self.hour_requests[ip]
            if timestamp > one_hour_ago
        ]
        
        if len(self.minute_requests[ip]) >= self.requests_per_minute:
            return False, f"Rate limit exceeded: {self.requests_per_minute} requests/min"
    
        if len(self.hour_requests[ip]) >= self.requests_per_hour:
            # Freeze for 15 minutes on hour limit
            freeze_until = datetime.now() + timedelta(minutes=15)
            return False, f"Hourly limit hit. Frozen until {freeze_until.strftime('%H:%M')}"
        
        return True, None
    
    def add_request(self, ip: str):
        """Add request timestamp for this IP"""
        current_time = datetime.now()
        self.minute_requests[ip].append(current_time)
        self.hour_requests[ip].append(current_time)
    
    def get_stats(self, ip: str) -> Dict:
        """Get rate limit stats for IP"""
        current_time = datetime.now()
        one_minute_ago = current_time - timedelta(minutes=1)
        one_hour_ago = current_time - timedelta(hours=1)
        
        minute_count = len([t for t in self.minute_requests[ip] if t > one_minute_ago])
        hour_count = len([t for t in self.hour_requests[ip] if t > one_hour_ago])
        
        return {
            "requests_last_minute": minute_count,
            "requests_last_hour": hour_count,
            "limit_minute": self.requests_per_minute,
            "limit_hour": self.requests_per_hour,
            "remaining_minute": self.requests_per_minute - minute_count,
            "remaining_hour": self.requests_per_hour - hour_count
        }

# Create global instance AFTER class definition
rate_limiter = RateLimiter()



def get_client_ip(request: Request) -> str:
    """Extract the real client IP, handling proxies"""
    # Check if behind a proxy
    forwarded = request.headers.get("X-Forwarded-For")
    if forwarded:
        # Take the first IP in the chain
        return forwarded.split(",")[0].strip()

    # Check for real IP header
    real_ip = request.headers.get("X-Real-IP")
    if real_ip:
        return real_ip

    # Fallback to direct connection IP
    return request.client.host if request.client else "unknown"


@app.middleware("http")
async def rate_limit_middleware(request: Request, call_next):
    excluded_paths = ["/", "/cache/clear", "/rate-limit/stats", "/cache/info"]
    if request.url.path in excluded_paths:
        return await call_next(request)

    client_ip = get_client_ip(request)
    allowed, error_msg = rate_limiter.is_allowed(client_ip)
    
    if not allowed:
        logger.warning(f"Rate limit hit for IP: {client_ip}")
        return JSONResponse(
            status_code=429,
            content={"detail": error_msg, "client_ip": client_ip},
            headers={"Retry-After": "60"}
        )

    # ADD THIS LINE - track the request
    rate_limiter.add_request(client_ip)
    
    response = await call_next(request)
    
    # Update headers with current stats
    stats = rate_limiter.get_stats(client_ip)
    response.headers["X-RateLimit-Limit-Minute"] = str(rate_limiter.requests_per_minute)
    response.headers["X-RateLimit-Remaining-Minute"] = str(rate_limiter.requests_per_minute - stats["requests_last_minute"])
    response.headers["X-RateLimit-Limit-Hour"] = str(rate_limiter.requests_per_hour)
    response.headers["X-RateLimit-Remaining-Hour"] = str(rate_limiter.requests_per_hour - stats["requests_last_hour"])
    
    return response


@app.get("/")
def health():
    """Simple health check endpoint"""
    return {"status": "running", "service": "SEC N-PORT Viewer"}


@app.get("/rate-limit/stats")
def rate_limit_stats(request: Request):
    """Check your current rate limit status"""
    client_ip = get_client_ip(request)
    stats = rate_limiter.get_stats(client_ip)
    stats["client_ip"] = client_ip
    return stats


@lru_cache(maxsize=256)
def get_nport_metadata(cik: str):
    """
    Fetch N-PORT filing metadata from SEC for a given CIK.
    Returns info about all N-PORT filings on the latest date.
    """
    try:
        # Pad CIK to 10 digits
        padded_cik = cik.zfill(10)
        url = f"https://data.sec.gov/submissions/CIK{padded_cik}.json"
        
        # Fetch from SEC API
        response = session.get(url, timeout=10)

        # Handle not found
        if response.status_code == 404:
            raise HTTPException(
                status_code=404, 
                detail=f"CIK {cik} not found in SEC database."
            )
        
        response.raise_for_status()
        data = response.json()
        
        # Extract basic info
        registrant_name = data.get("name", "Unknown Registrant")

        # Get recent filings
        filings = data.get("filings", {}).get("recent", {})
        forms = filings.get("form", [])
        accession_numbers = filings.get("accessionNumber", [])
        filing_dates = filings.get("filingDate", [])
        primary_documents = filings.get("primaryDocument", [])

        # Filter to only N-PORT forms
        nport_records = []
        for form, acc, date, doc in zip(forms, accession_numbers, filing_dates, primary_documents):
            if form in NPORT_FORMS:
                nport_records.append({
                    "form": form,
                    "accession": acc,
                    "date": date,
                    "primary_doc": doc,
                })

        # Check if we found any N-PORT filings
        if not nport_records:
            raise HTTPException(
                status_code=404,
                detail=f"No N-PORT filings found for {registrant_name} (CIK: {cik}).",
            )

        # Find the most recent filing date
        most_recent_date = max(record["date"] for record in nport_records)
        
        # Get all filings from that date
        latest_filings = [r for r in nport_records if r["date"] == most_recent_date]
        
        # Sort for consistency
        latest_filings.sort(key=lambda r: (r["form"], r["accession"]))

        logger.info(
            f"Found {len(latest_filings)} N-PORT filings on {most_recent_date} "
            f"for {registrant_name} ({cik})"
        )

        # Pick the first one as default
        default_filing = latest_filings[0]

        return {
            "name": registrant_name,
            "latest_date": most_recent_date,
            "default_accession": default_filing["accession"],
            "default_primary_doc": default_filing["primary_doc"],
            "default_form": default_filing["form"],
            "latest_date_nport_filings": latest_filings,
        }

    except HTTPException:
        raise
    except requests.RequestException as e:
        logger.error(f"Network error for CIK {cik}: {str(e)}")
        raise HTTPException(status_code=503, detail="SEC API unavailable.")


@lru_cache(maxsize=128)
def fetch_html_content(html_url: str) -> bytes:
    """Download and cache HTML content from SEC"""
    response = session.get(html_url, timeout=60)

    # Handle rate limiting from SEC
    if response.status_code == 403:
        raise HTTPException(
            status_code=403, 
            detail="SEC blocked request. Wait and retry."
        )

    # Handle other errors
    if response.status_code != 200:
        raise HTTPException(
            status_code=404,
            detail=f"Could not fetch filing (HTTP {response.status_code}). Document may not be available."
        )

    return response.content


def extract_series_name(html_content: bytes) -> Optional[str]:
    """
    Try to extract the series name from N-PORT HTML.
    Returns None if not found.
    """
    try:
        soup = BeautifulSoup(html_content, "lxml")

        # Method 1: Look in Part A, Item A.2
        part_a = soup.find(
            "h1",
            string=lambda text: text and "NPORT-P: Part A: General Information" in text,
        )
        
        if part_a:
            item_a2 = part_a.find_next(
                "h4",
                string=lambda text: text and "Item A.2. Information about the Series" in text,
            )
            
            if item_a2:
                table = item_a2.find_next("table")
                if table:
                    cells = table.find_all("td")
                    for idx, cell in enumerate(cells):
                        text = cell.get_text(strip=True)
                        if "a. Name of Series" in text and idx + 1 < len(cells):
                            name = cells[idx + 1].get_text(strip=True)
                            if name:
                                return name

        # Method 2: Look for Item B.1
        series_headers = soup.find_all(
            "h4",
            string=lambda text: text and "Item B.1. Name of series" in text,
        )
        
        for header in series_headers:
            table = header.find_next("table")
            if table:
                cells = table.find_all("td")
                for idx, cell in enumerate(cells):
                    if "a. Name of series" in cell.get_text(strip=True) and idx + 1 < len(cells):
                        name = cells[idx + 1].get_text(strip=True)
                        if name:
                            return name

        # Method 3: Generic search
        for cell in soup.find_all("td"):
            text = cell.get_text(strip=True)
            if "Name of series" in text:
                next_cell = cell.find_next_sibling("td")
                if next_cell:
                    name = next_cell.get_text(strip=True)
                    if name:
                        return name

        return None

    except Exception as e:
        logger.warning(f"Could not extract series name: {str(e)}")
        return None


def parse_nport_html(html_content: bytes, cik: str, limit: Optional[int] = None) -> tuple[List[Dict], Optional[str]]:
    """
    Parse N-PORT HTML to extract portfolio holdings.
    Returns (holdings_list, reporting_period)
    """
    try:
        soup = BeautifulSoup(html_content, 'lxml')
        holdings = []

        # First, try to get the reporting period
        reporting_period = None
        general_info_sections = soup.find_all(
            'h1', 
            string=lambda text: text and 'NPORT-P: Part A: General Information' in text
        )
        
        for section in general_info_sections:
            period_header = section.find_next(
                'h4', 
                string=lambda text: text and 'Item A.3. Reporting period' in text
            )
            
            if period_header:
                table = period_header.find_next('table')
                if table:
                    date_cell = table.find(
                        'td', 
                        string=lambda text: text and 'b. Date as of which information is reported' in text
                    )
                    if date_cell:
                        reporting_period = date_cell.find_next_sibling('td').get_text(strip=True)
                        break

        # Now find all investment sections
        investment_headers = soup.find_all(
            'h1', 
            string=lambda text: text and 'NPORT-P: Part C: Schedule of Portfolio Investments' in text
        )

        logger.info(f"Found {len(investment_headers)} investments in HTML")

        # Process each investment
        for idx, investment in enumerate(investment_headers):
            # Stop if we hit the limit
            if limit and idx >= limit:
                break

            holding = {}

            # Get identification info (Item C.1)
            c1_header = investment.find_next(
                'h4', 
                string=lambda text: text and 'Item C.1. Identification of investment' in text
            )
            
            if c1_header:
                c1_table = c1_header.find_next('table')
                if c1_table:
                    cells = c1_table.find_all('td')
                    cell_texts = [c.get_text(strip=True) for c in cells]

                    for i, text in enumerate(cell_texts):
                        if 'a. Name of issuer' in text and i + 1 < len(cell_texts):
                            holding["title"] = cell_texts[i + 1]
                        elif 'd. CUSIP' in text and i + 1 < len(cell_texts):
                            holding["cusip"] = cell_texts[i + 1]

            # Get amount info (Item C.2)
            c2_header = investment.find_next(
                'h4', 
                string=lambda text: text and 'Item C.2. Amount of each investment' in text
            )
            
            if c2_header:
                c2_table = c2_header.find_next('table')
                if c2_table:
                    cells = c2_table.find_all('td')
                    cell_texts = [c.get_text(strip=True) for c in cells]

                    for i, text in enumerate(cell_texts):
                        if 'Balance' in text and i + 1 < len(cell_texts):
                            try:
                                value = float(cell_texts[i + 1].replace(',', ''))
                                # Handle infinity and NaN
                                if math.isinf(value) or math.isnan(value):
                                    holding["balance"] = 0.0
                                else:
                                    holding["balance"] = value
                            except (ValueError, AttributeError):
                                holding["balance"] = 0.0
                                
                        elif 'Report values in U.S. dollars' in text and i + 1 < len(cell_texts):
                            try:
                                value = float(cell_texts[i + 1].replace(',', ''))
                                # Handle infinity and NaN
                                if math.isinf(value) or math.isnan(value):
                                    holding["value"] = 0.0
                                else:
                                    holding["value"] = value
                            except (ValueError, AttributeError):
                                holding["value"] = 0.0

            # Only add if we have minimum required data
            if holding.get("title") and "value" in holding:
                # Fill in missing fields with defaults
                if "cusip" not in holding:
                    holding["cusip"] = "N/A"
                if "balance" not in holding:
                    holding["balance"] = 0.0
                    
                holdings.append(holding)

        if not holdings:
            logger.warning("No holdings extracted from HTML")

        return holdings, reporting_period

    except Exception as e:
        logger.error(f"HTML parsing error: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to parse HTML filing: {str(e)}")


@lru_cache(maxsize=64)
def get_holdings_cached(cik: str, limit: Optional[int] = None):
    """
    Main function to fetch and parse N-PORT holdings.
    Handles multiple filings on the same date.
    """
    start_time = time.time()

    # Get metadata about available filings
    metadata = get_nport_metadata(cik)
    fund_name = metadata["name"]
    filing_date = metadata["latest_date"]
    available_filings = metadata["latest_date_nport_filings"]

    results = []

    # Process each filing
    for idx, filing in enumerate(available_filings):
        accession = filing["accession"]
        primary_doc = filing["primary_doc"]
        form_type = filing["form"]

        # Build URL
        accession_no_dash = accession.replace("-", "")
        
        if primary_doc:
            url = f"https://www.sec.gov/Archives/edgar/data/{cik}/{accession_no_dash}/{primary_doc}"
        else:
            url = f"https://www.sec.gov/Archives/edgar/data/{cik}/{accession_no_dash}/primary_doc.xml"

        logger.info(f"Fetching HTML from: {url}")

        # Try to download the HTML
        try:
            html_content = fetch_html_content(url)
        except HTTPException as e:
            # Try alternative URLs if primary fails
            if e.status_code == 404:
                alternative_urls = [
                    f"https://www.sec.gov/cgi-bin/viewer?action=view&cik={cik}&accession_number={accession}&xbrl_type=v",
                    f"https://www.sec.gov/Archives/edgar/data/{cik}/{accession_no_dash}/xslFormNPORT-P_X01/primary_doc.xml",
                ]
                
                html_content = None
                for alt_url in alternative_urls:
                    logger.info(f"Trying alternative URL: {alt_url}")
                    try:
                        html_content = fetch_html_content(alt_url)
                        url = alt_url
                        break
                    except Exception:
                        continue
                
                if html_content is None:
                    logger.warning(f"Skipping filing {accession}: could not fetch HTML")
                    continue
            else:
                raise
        except requests.Timeout:
            raise HTTPException(status_code=504, detail="Request timeout.")
        except Exception as e:
            logger.error(f"Error fetching HTML for {accession}: {str(e)}")
            continue

        # Try to extract series name
        series_name = extract_series_name(html_content)

        # Parse the HTML
        holdings, reporting_period = parse_nport_html(html_content, cik, limit)

        if not holdings:
            logger.warning(
                f"No holdings found in filing {accession}. "
                "The document may use a non-standard format."
            )
            continue

        # Use reporting period if available, otherwise use filing date
        effective_date = reporting_period or filing_date
        
        # Calculate total assets
        total_assets = sum(h.get("value", 0) for h in holdings)

        # Generate a default series name if we couldn't extract one
        if not series_name:
            series_name = f"Series {chr(65 + idx)}"  # Series A, B, C, etc.

        results.append({
            "form": form_type,
            "series_name": series_name,
            "accession_number": accession,
            "filing_url": url,
            "filing_date": effective_date,
            "holdings_count": len(holdings),
            "total_assets": total_assets,
            "holdings": holdings,
        })

    # Make sure we got at least one valid filing
    if not results:
        raise HTTPException(
            status_code=422,
            detail="No holdings found in any latest-date N-PORT filings for this CIK.",
        )

    elapsed = time.time() - start_time
    logger.info(
        f"Successfully extracted holdings from {len(results)} N-PORT filings "
        f"for {fund_name} in {elapsed:.2f}s"
    )

    return {
        "cik": cik,
        "registrant_name": fund_name,
        "latest_date": filing_date,
        "filing_groups": results,
        "processing_time": f"{elapsed:.2f}s",
    }


async def stream_holdings_generator(cik: str, limit: Optional[int] = None, task_id: str = None):
    """
    Generator that yields holdings data as Server-Sent Events.
    Each series is sent as soon as it's ready.
    """
    try:
        if task_id:
            active_tasks[task_id] = asyncio.current_task()

        if task_id and task_id in active_tasks and active_tasks[task_id].done():
            yield f"data: {json.dumps({'type': 'cancelled'})}\n\n"
            return

        start_time = time.time()

        # Get metadata about available filings
        metadata = get_nport_metadata(cik)
        fund_name = metadata["name"]
        filing_date = metadata["latest_date"]
        available_filings = metadata["latest_date_nport_filings"]

        # Send initial metadata
        yield f"data: {json.dumps({'type': 'metadata', 'registrant_name': fund_name, 'latest_date': filing_date, 'total_filings': len(available_filings)})}\n\n"

        processed_count = 0

        # Process each filing and stream results
        for idx, filing in enumerate(available_filings):
            accession = filing["accession"]
            primary_doc = filing["primary_doc"]
            form_type = filing["form"]

            # Send progress update
            yield f"data: {json.dumps({'type': 'progress', 'current': idx + 1, 'total': len(available_filings), 'accession': accession})}\n\n"

            # Build URL
            accession_no_dash = accession.replace("-", "")
            
            if primary_doc:
                url = f"https://www.sec.gov/Archives/edgar/data/{cik}/{accession_no_dash}/{primary_doc}"
            else:
                url = f"https://www.sec.gov/Archives/edgar/data/{cik}/{accession_no_dash}/primary_doc.xml"

            logger.info(f"Streaming: Fetching HTML from: {url}")

            # Try to download the HTML
            try:
                html_content = fetch_html_content(url)
            except HTTPException as e:
                # Try alternative URLs if primary fails
                if e.status_code == 404:
                    alternative_urls = [
                        f"https://www.sec.gov/cgi-bin/viewer?action=view&cik={cik}&accession_number={accession}&xbrl_type=v",
                        f"https://www.sec.gov/Archives/edgar/data/{cik}/{accession_no_dash}/xslFormNPORT-P_X01/primary_doc.xml",
                    ]
                    
                    html_content = None
                    for alt_url in alternative_urls:
                        logger.info(f"Trying alternative URL: {alt_url}")
                        try:
                            html_content = fetch_html_content(alt_url)
                            url = alt_url
                            break
                        except Exception:
                            continue
                    
                    if html_content is None:
                        logger.warning(f"Skipping filing {accession}: could not fetch HTML")
                        yield f"data: {json.dumps({'type': 'error', 'accession': accession, 'message': 'Could not fetch HTML'})}\n\n"
                        continue
                else:
                    raise
            except requests.Timeout:
                yield f"data: {json.dumps({'type': 'error', 'accession': accession, 'message': 'Request timeout'})}\n\n"
                continue
            except Exception as e:
                logger.error(f"Error fetching HTML for {accession}: {str(e)}")
                yield f"data: {json.dumps({'type': 'error', 'accession': accession, 'message': str(e)})}\n\n"
                continue

            # Try to extract series name
            series_name = extract_series_name(html_content)

            # Parse the HTML
            holdings, reporting_period = parse_nport_html(html_content, cik, limit)

            if not holdings:
                logger.warning(f"No holdings found in filing {accession}")
                yield f"data: {json.dumps({'type': 'warning', 'accession': accession, 'message': 'No holdings found'})}\n\n"
                continue

            # Use reporting period if available, otherwise use filing date
            effective_date = reporting_period or filing_date
            
            # Calculate total assets
            total_assets = sum(h.get("value", 0) for h in holdings)

            # Generate a default series name if we couldn't extract one
            if not series_name:
                series_name = f"Series {chr(65 + idx)}"  # Series A, B, C, etc.

            # Send this series result immediately
            result = {
                "type": "series",
                "index": processed_count,
                "data": {
                    "form": form_type,
                    "series_name": series_name,
                    "accession_number": accession,
                    "filing_url": url,
                    "filing_date": effective_date,
                    "holdings_count": len(holdings),
                    "total_assets": total_assets,
                    "holdings": holdings,
                }
            }
            
            yield f"data: {json.dumps(result)}\n\n"
            processed_count += 1

            # Small delay to prevent overwhelming the client
            await asyncio.sleep(0.1)

        # Send completion message
        elapsed = time.time() - start_time
        yield f"data: {json.dumps({'type': 'complete', 'total_processed': processed_count, 'processing_time': f'{elapsed:.2f}s'})}\n\n"

    except HTTPException as e:
        yield f"data: {json.dumps({'type': 'error', 'message': e.detail, 'status_code': e.status_code})}\n\n"
    except Exception as e:
        logger.error(f"Streaming error: {str(e)}")
        yield f"data: {json.dumps({'type': 'error', 'message': str(e)})}\n\n"


@app.get("/holdings/{cik}/stream")
async def stream_holdings(
    request: Request,
    cik: str,
    limit: Optional[int] = Query(None),
    task_id: Optional[str] = Query(None)
):
    clean_cik = cik.strip().zfill(10) 
    if not clean_cik.isdigit():
        raise HTTPException(status_code=00, detail="Invalid CIK format.")

    # Generate task_id if not provided
    stream_task_id = task_id or str(uuid.uuid4())
    
    return StreamingResponse(
        stream_holdings_generator(clean_cik, limit, stream_task_id),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
            "X-Task-ID": stream_task_id
        }
    )


@app.post("/stream/{task_id}/cancel")
async def cancel_stream(task_id: str):
    """Cancel a streaming request by task_id"""
    if task_id in active_tasks:
        active_tasks[task_id].cancel()
        del active_tasks[task_id]
        return {"status": "cancelled", "task_id": task_id}
    return {"status": "not_found", "task_id": task_id}


@app.get("/holdings/{cik}")
def get_holdings(
    request: Request,
    cik: str,
    limit: Optional[int] = Query(None, description="Limit number of holdings returned (default: all)")
):
    """
    Main API endpoint to get N-PORT holdings for a CIK.
    Returns all results at once (use /holdings/{cik}/stream for progressive loading).
    """
    # 🚀 NORMALIZE CIK BEFORE VALIDATION
    clean_cik = cik.strip().zfill(10)  # Always pad to 10 digits FIRST
    
    if not clean_cik.isdigit():
        raise HTTPException(status_code=400, detail="Invalid CIK format.")

    # Return cached result (always uses 10-digit CIK)
    return get_holdings_cached(clean_cik, limit)



@app.delete("/cache/clear")
def clear_cache():
    """Clear all LRU caches (useful for development)"""
    get_nport_metadata.cache_clear()
    get_holdings_cached.cache_clear()
    fetch_html_content.cache_clear()
    
    return {
        "status": "cache cleared", 
        "timestamp": datetime.now().isoformat()
    }


@app.get("/cache/info")
def cache_info():
    """Get statistics about cache usage"""
    metadata_info = get_nport_metadata.cache_info()
    html_info = fetch_html_content.cache_info()
    holdings_info = get_holdings_cached.cache_info()
    
    return {
        "metadata_cache": {
            "size": metadata_info.currsize,
            "maxsize": metadata_info.maxsize,
            "hits": metadata_info.hits,
            "misses": metadata_info.misses,
        },
        "html_cache": {
            "size": html_info.currsize,
            "maxsize": html_info.maxsize,
            "hits": html_info.hits,
            "misses": html_info.misses,
        },
        "holdings_cache": {
            "size": holdings_info.currsize,
            "maxsize": holdings_info.maxsize,
            "hits": holdings_info.hits,
            "misses": holdings_info.misses,
        }
    }