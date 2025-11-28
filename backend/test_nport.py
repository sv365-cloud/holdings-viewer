import pytest
import requests  
from fastapi.testclient import TestClient
from unittest.mock import Mock, patch, MagicMock
from fastapi import HTTPException
from main import app, get_nport_metadata, parse_nport_html, get_holdings_cached, rate_limiter
import math
import json
import asyncio
# Create test client
client = TestClient(app)


@pytest.fixture(autouse=True)
def reset_rate_limiter():
    """Reset rate limiter before each test"""
    rate_limiter.minute_requests.clear()
    rate_limiter.hour_requests.clear()
    yield


@pytest.fixture
def mock_session():
    """Mock the requests session"""
    with patch('main.session') as mock:
        yield mock


@pytest.fixture(autouse=True)
def clear_caches():
    """Clear all caches before each test"""
    get_nport_metadata.cache_clear()
    get_holdings_cached.cache_clear()
    yield
    get_nport_metadata.cache_clear()
    get_holdings_cached.cache_clear()


# ============================================================================
# HEALTH CHECK TESTS
# ============================================================================

def test_health_check():
    response = client.get("/")
    assert response.status_code == 200
    assert response.json() == {"status": "running", "service": "SEC N-PORT Viewer"}


def test_rate_limit_stats():
    """Test rate limit stats endpoint"""
    response = client.get("/rate-limit/stats")
    assert response.status_code == 200
    data = response.json()
    assert "client_ip" in data
    assert "requests_last_minute" in data
    assert "limit_minute" in data      
    assert "requests_last_hour" in data
    assert "limit_hour" in data     
    assert "remaining_minute" in data
    assert "remaining_hour" in data



def test_cache_info():
    """Test cache info endpoint"""
    response = client.get("/cache/info")
    assert response.status_code == 200
    data = response.json()
    assert "metadata_cache" in data
    assert "html_cache" in data
    assert "holdings_cache" in data


# ============================================================================
# RATE LIMITING TESTS
# ============================================================================

def test_rate_limiting_per_minute():
    """Test that rate limiting works per minute"""
    # Make requests up to the limit (10 per minute)
    for i in range(10):
        response = client.get(f"/holdings/0001166559") 
        assert response.status_code in [200, 400, 404, 422, 503]  
    
    # 11th request should be rate limited
    response = client.get("/holdings/0001166559")
    assert response.status_code == 429
    assert "Rate limit exceeded" in response.json()["detail"]


def test_rate_limit_headers():
    """Test that rate limit headers are present"""
    response = client.get("/rate-limit/stats")
    # Rate limit stats endpoint shouldn't have rate limit headers (it's excluded)
    
    # But holdings endpoint should have them
    response = client.get("/holdings/0001166559")
    if response.status_code != 429: 
        assert "X-RateLimit-Limit-Minute" in response.headers or response.status_code in [404, 400, 422]


def test_parse_nport_html_valid():
    """Test parsing valid N-PORT HTML"""
    sample_html = """
    <html>
        <h1>NPORT-P: Part A: General Information</h1>
        <h4>Item A.3. Reporting period</h4>
        <table>
            <tr>
                <td>b. Date as of which information is reported</td>
                <td>2024-03-31</td>
            </tr>
        </table>
        <h1>NPORT-P: Part C: Schedule of Portfolio Investments</h1>
        <h4>Item C.1. Identification of investment</h4>
        <table>
            <tr>
                <td>a. Name of issuer</td>
                <td>Apple Inc</td>
            </tr>
            <tr>
                <td>d. CUSIP</td>
                <td>037833100</td>
            </tr>
        </table>
        <h4>Item C.2. Amount of each investment</h4>
        <table>
            <tr>
                <td>Balance</td>
                <td>1000</td>
            </tr>
            <tr>
                <td>Report values in U.S. dollars</td>
                <td>150000.50</td>
            </tr>
        </table>
    </html>
    """
    
    holdings, reporting_period = parse_nport_html(sample_html.encode(), "0001166559")
    
    assert reporting_period == "2024-03-31"
    assert len(holdings) == 1
    assert holdings[0]["title"] == "Apple Inc"
    assert holdings[0]["cusip"] == "037833100"
    assert holdings[0]["balance"] == 1000.0
    assert holdings[0]["value"] == 150000.50


def test_parse_nport_html_inf_nan():
    """Test that inf and nan values are handled correctly"""
    sample_html = """
    <html>
        <h1>NPORT-P: Part C: Schedule of Portfolio Investments</h1>
        <h4>Item C.1. Identification of investment</h4>
        <table>
            <tr>
                <td>a. Name of issuer</td>
                <td>Test Company</td>
            </tr>
        </table>
        <h4>Item C.2. Amount of each investment</h4>
        <table>
            <tr>
                <td>Balance</td>
                <td>inf</td>
            </tr>
            <tr>
                <td>Report values in U.S. dollars</td>
                <td>100</td>
            </tr>
        </table>
    </html>
    """
    
    holdings, _ = parse_nport_html(sample_html.encode(), "0001166559")
    
    assert len(holdings) == 1
    assert holdings[0]["balance"] == 0.0 
    assert holdings[0]["value"] == 100.0


def test_parse_nport_html_limit():
    """Test that limit parameter works correctly"""
    sample_html = """
    <html>
        <h1>NPORT-P: Part C: Schedule of Portfolio Investments</h1>
        <h4>Item C.1. Identification of investment</h4>
        <table><tr><td>a. Name of issuer</td><td>Company 1</td></tr></table>
        <h4>Item C.2. Amount of each investment</h4>
        <table><tr><td>Report values in U.S. dollars</td><td>100</td></tr></table>
        
        <h1>NPORT-P: Part C: Schedule of Portfolio Investments</h1>
        <h4>Item C.1. Identification of investment</h4>
        <table><tr><td>a. Name of issuer</td><td>Company 2</td></tr></table>
        <h4>Item C.2. Amount of each investment</h4>
        <table><tr><td>Report values in U.S. dollars</td><td>200</td></tr></table>
        
        <h1>NPORT-P: Part C: Schedule of Portfolio Investments</h1>
        <h4>Item C.1. Identification of investment</h4>
        <table><tr><td>a. Name of issuer</td><td>Company 3</td></tr></table>
        <h4>Item C.2. Amount of each investment</h4>
        <table><tr><td>Report values in U.S. dollars</td><td>300</td></tr></table>
    </html>
    """
    
    holdings, _ = parse_nport_html(sample_html.encode(), "0001166559", limit=2)
    assert len(holdings) == 2
    assert holdings[0]["title"] == "Company 1"
    assert holdings[1]["title"] == "Company 2"


# ============================================================================
# METADATA TESTS
# ============================================================================

def test_get_nport_metadata_success(mock_session):
    """Test successful metadata retrieval"""
    mock_response = Mock()
    mock_response.status_code = 200
    mock_response.json.return_value = {
        "name": "Test Fund",
        "filings": {
            "recent": {
                "form": ["NPORT-P", "10-K"],
                "accessionNumber": ["0001234567-24-000001", "0001234567-24-000002"],
                "filingDate": ["2024-03-31", "2024-03-15"],
                "primaryDocument": ["primary_doc.xml", "form10k.htm"]
            }
        }
    }
    mock_session.get.return_value = mock_response
    
    result = get_nport_metadata("0001166559")
    
    assert result["name"] == "Test Fund"
    assert result["latest_date"] == "2024-03-31"
    assert len(result["latest_date_nport_filings"]) == 1
    assert result["latest_date_nport_filings"][0]["form"] == "NPORT-P"


def test_get_nport_metadata_not_found(mock_session):
    """Test metadata retrieval with 404 response"""
    mock_response = Mock()
    mock_response.status_code = 404
    mock_response.raise_for_status.side_effect = Exception("404 Not Found")
    mock_session.get.return_value = mock_response
    
    with pytest.raises(HTTPException) as exc_info:
        get_nport_metadata("9999999999")
    
    assert exc_info.value.status_code == 404
    assert "not found" in str(exc_info.value.detail).lower()


def test_get_nport_metadata_no_nport_filings(mock_session):
    """Test metadata when no N-PORT filings exist"""
    mock_response = Mock()
    mock_response.status_code = 200
    mock_response.json.return_value = {
        "name": "Test Fund",
        "filings": {
            "recent": {
                "form": ["10-K", "8-K"],
                "accessionNumber": ["0001234567-24-000001", "0001234567-24-000002"],
                "filingDate": ["2024-03-31", "2024-03-15"],
                "primaryDocument": ["form10k.htm", "form8k.htm"]
            }
        }
    }
    mock_session.get.return_value = mock_response
    
    with pytest.raises(HTTPException) as exc_info:
        get_nport_metadata("0001166559")
    
    assert exc_info.value.status_code == 404
    assert "No N-PORT filings found" in exc_info.value.detail


def test_get_nport_metadata_multiple_same_date(mock_session):
    """Test metadata with multiple N-PORT filings on the same date"""
    mock_response = Mock()
    mock_response.status_code = 200
    mock_response.json.return_value = {
        "name": "Test Fund",
        "filings": {
            "recent": {
                "form": ["NPORT-P", "NPORT-P/A", "NPORT-P"],
                "accessionNumber": ["0001234567-24-000001", "0001234567-24-000002", "0001234567-24-000003"],
                "filingDate": ["2024-03-31", "2024-03-31", "2024-03-15"],
                "primaryDocument": ["doc1.xml", "doc2.xml", "doc3.xml"]
            }
        }
    }
    mock_session.get.return_value = mock_response
    
    result = get_nport_metadata("0001166559")
    
    assert result["latest_date"] == "2024-03-31"
    assert len(result["latest_date_nport_filings"]) == 2  # Only the two from latest date
    assert result["latest_date_nport_filings"][0]["date"] == "2024-03-31"
    assert result["latest_date_nport_filings"][1]["date"] == "2024-03-31"


# ============================================================================
# INTEGRATION TESTS (with mocked external calls)
# ============================================================================

def test_get_holdings_endpoint(mock_session):
    """Test the main holdings endpoint"""
    # Mock metadata response
    metadata_response = Mock()
    metadata_response.status_code = 200
    metadata_response.json.return_value = {
        "name": "Test Fund",
        "filings": {
            "recent": {
                "form": ["NPORT-P"],
                "accessionNumber": ["0001234567-24-000001"],
                "filingDate": ["2024-03-31"],
                "primaryDocument": ["primary_doc.xml"]
            }
        }
    }
    
    # Mock HTML response
    html_response = Mock()
    html_response.status_code = 200
    html_response.content = b"""
    <html>
        <h1>NPORT-P: Part C: Schedule of Portfolio Investments</h1>
        <h4>Item C.1. Identification of investment</h4>
        <table>
            <tr><td>a. Name of issuer</td><td>Test Company</td></tr>
            <tr><td>d. CUSIP</td><td>123456789</td></tr>
        </table>
        <h4>Item C.2. Amount of each investment</h4>
        <table>
            <tr><td>Balance</td><td>100</td></tr>
            <tr><td>Report values in U.S. dollars</td><td>10000</td></tr>
        </table>
    </html>
    """
    
    # Configure mock to return different responses
    mock_session.get.side_effect = [metadata_response, html_response]
    
    response = client.get("/holdings/0001166559")
    
    assert response.status_code == 200
    data = response.json()
    assert "registrant_name" in data
    assert "filing_groups" in data
    assert len(data["filing_groups"]) > 0


def test_get_holdings_invalid_cik():
    """Test holdings endpoint with invalid CIK"""
    response = client.get("/holdings/invalid")
    assert response.status_code == 400
    assert "Invalid CIK format" in response.json()["detail"]


def test_get_holdings_with_limit():
    """Test holdings endpoint with limit parameter"""
    response = client.get("/holdings/0001166559?limit=10")
    # Should return 400, 404, or 422 depending on whether CIK exists
    assert response.status_code in [200, 400, 404, 422, 503]


# ============================================================================
# CACHE TESTS
# ============================================================================

def test_cache_clear():
    """Test cache clearing endpoint"""
    response = client.delete("/cache/clear")
    assert response.status_code == 200
    assert response.json()["status"] == "cache cleared"
    assert "timestamp" in response.json()


def test_metadata_caching(mock_session):
    """Test that metadata is cached properly"""
    mock_response = Mock()
    mock_response.status_code = 200
    mock_response.json.return_value = {
        "name": "Test Fund",
        "filings": {
            "recent": {
                "form": ["NPORT-P"],
                "accessionNumber": ["0001234567-24-000001"],
                "filingDate": ["2024-03-31"],
                "primaryDocument": ["primary_doc.xml"]
            }
        }
    }
    mock_session.get.return_value = mock_response
    
    # First call
    result1 = get_nport_metadata("0001166559")
    
    # Second call should use cache
    result2 = get_nport_metadata("0001166559")
    
    # Should only call the API once
    assert mock_session.get.call_count == 1
    assert result1 == result2


def test_stream_cancel():
    """Test cancelling a stream returns proper response"""
    # Test non-existent task
    response = client.post("/stream/nonexistent/cancel")
    assert response.status_code == 200
    assert response.json()["status"] == "not_found" 
    
    # Test cancel response format
    response = client.post("/stream/test-123/cancel")
    assert response.status_code == 200
    assert "status" in response.json()

def test_stream_holdings_headers(mock_session):
    """Test streaming endpoint returns correct headers"""
    metadata_response = Mock()
    metadata_response.status_code = 200
    metadata_response.json.return_value = {
        "name": "Test Fund",
        "filings": {
            "recent": {
                "form": ["NPORT-P"],
                "accessionNumber": ["0001234567-24-000001"],
                "filingDate": ["2024-03-31"],
                "primaryDocument": ["primary_doc.xml"]
            }
        }
    }
    html_response = Mock()
    html_response.status_code = 200
    html_response.content = b"<html>mock html</html>"
    mock_session.get.side_effect = [metadata_response, html_response]
    
    response = client.get("/holdings/0001166559/stream?task_id=test")
    
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream") 
    assert "X-Task-ID" in response.headers



def test_holdings_rate_limit_403(mock_session):
    """Test handling 403 forbidden from SEC API"""

    mock_response = Mock()
    mock_response.status_code = 403
    mock_response.json.return_value = {}
    # Simulate raise_for_status raising HTTPError for 403
    mock_response.raise_for_status.side_effect = requests.exceptions.HTTPError(
        response=mock_response
    )
    mock_session.get.return_value = mock_response

    response = client.get("/holdings/0001166559")
    assert response.status_code == 503



def test_holdings_timeout(mock_session):
    """Test handling timeout exception"""
    mock_session.get.side_effect = requests.exceptions.Timeout("Request timed out")
    
    response = client.get("/holdings/0001166559")
    assert response.status_code == 503  




def test_parse_empty_html():
    """Test parse_nport_html with empty HTML returns empty holdings"""

    holdings, period = parse_nport_html(b"<html></html>", "0001166559")
    assert holdings == []
    assert period is None


if __name__ == "__main__":
    pytest.main([__file__, "-v"])