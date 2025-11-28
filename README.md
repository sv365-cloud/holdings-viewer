# HoldingsViewer

A web application for retrieving and visualizing fund holdings from SEC N-PORT filings. Users can enter a Central Index Key (CIK) to fetch and display a fund's portfolio holdings, including CUSIP, title, balance, and market value.

## 📋 Project Description

Registered funds—including open-ended, closed-ended, and exchange-traded funds—must file a monthly Form N-PORT with the SEC. Each fund is identified by a unique Central Index Key (CIK). This application retrieves the most recent N-PORT filing for a given CIK and displays the portfolio holdings from "Part C: Schedule of Portfolio Investments."


---

## 🚀 Features

### Core Functionality
- **CIK Search**: Enter any valid CIK to retrieve fund holdings
- **Real-time Streaming**: Server-Sent Events for live progress updates during data fetching
- **Multi-Series Support**: Handles funds with multiple series filings on the same date
- **Automatic URL Fallback**: Intelligently tries alternative SEC URLs if primary document fails

### Enhanced Features
- ✅ **Error Handling**: Comprehensive error handling with user-friendly messages
- ✅ **Enhanced UI/UX**: Sorting, filtering, pagination, and responsive design
- ✅ **Data Visualization**: Interactive donut charts showing portfolio allocation
- ✅ **Caching and Performance**: Multi-layer caching (backend LRU cache + frontend client cache)
- ✅ **Security Enhancements**: Custom rate limiter to prevent API abuse (10 req/min, 100 req/hour)
- ✅ **Testing**: Comprehensive unit tests

---


## 📂 Project Structure

```
holdings-viewer/
│
├── backend/
│   ├── main.py                 # FastAPI application with all endpoints
│   ├── requirements.txt        # Python dependencies
│   ├── test_nport.py          # Comprehensive unit tests
│   └── .gitignore
│
├── frontend/
│   ├── src/
│   │   ├── App.jsx            # Main React component with state management
│   │   ├── Config.jsx         # Backend URL configuration
│   │   ├── main.jsx           # React entry point
│   │   └── components/
│   │       ├── Navbar.jsx     # Navigation bar component
│   │       ├── ResultsDashboard.jsx # Holdings display with filtering/sorting
│   │       └── SimpleDonutChart.jsx # Portfolio allocation visualization
│   ├── package.json
│   ├── vite.config.js
│   └── .gitignore
│
├── README.md                  
└── .gitignore
```

---


## ⚙️ Local Setup Instructions

### Prerequisites
- **Python 3.11+** (for backend)
- **Node.js 18+** and **npm** (for frontend)
- **Git** (for cloning repository)

### Backend Setup

1. **Navigate to backend directory**
   ```bash
   cd backend
   ```

2. **Create virtual environment** (recommended)
   ```bash
   python3 -m venv venv
   source venv/bin/activate 
   ```

3. **Install dependencies**
   ```bash
   pip install -r requirements.txt
   ```

4. **Run the server**
   ```bash
   uvicorn main:app --reload --host 0.0.0.0 --port 8000
   ```

   The backend will be available at: `http://localhost:8000`

5. **Verify it's running**
   ```bash
   curl http://localhost:8000/
   ```

### Frontend Setup

1. **Navigate to frontend directory**
   ```bash
   cd frontend
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Start development server**
   ```bash
   npm run dev
   ```

   The frontend will be available at: `http://localhost:5173`

4. **Build for production** (optional)
   ```bash
   npm run build
   ```

### Running Both Services

**Terminal 1 (Backend):**
```bash
cd backend
source venv/bin/activate  # If using venv
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

**Terminal 2 (Frontend):**
```bash
cd frontend
npm run dev
```

Visit `http://localhost:5173` in your browser.

---

## 🧪 Testing

The backend includes comprehensive unit tests in `backend/test_nport.py`.

### Running Tests
```bash
cd backend
python test_nport.py
```

Alternatively, you can run with pytest directly:
```bash
pytest -v
```

### Test Coverage

The test suite covers all critical functionality:
- **Health checks** and endpoint availability
- **Rate limiting** (minute/hour limits, IP tracking, rolling windows)
- **Caching** (LRU cache behavior, hit/miss tracking, clearing)
- **CIK validation** (normalization, format validation)
- **SEC API parsing** (metadata extraction, multiple filings, date sorting)
- **HTML parsing** (holdings extraction, CUSIP/title/balance/value parsing, infinity/NaN handling)
- **Error handling** (404/403/timeout errors, network failures)
- **Server-Sent Events** (streaming, progress updates, cancellation)
- **End-to-end integration** with mocked SEC API calls

All tests use pytest fixtures and httpx for async testing, with external SEC API calls mocked for reliability.

---

## 🚀 Deployment

### Backend Deployment (Render)

1. Push code to GitHub
2. Create account on [Render.com](https://render.com)
3. Create new Web Service
4. Connect GitHub repository
5. Configure:
   - **Root Directory**: `backend`
   - **Build Command**: `pip install -r requirements.txt`
   - **Start Command**: `gunicorn main:app --bind 0.0.0.0:$PORT --workers 2 --timeout 120 --worker-class uvicorn.workers.UvicornWorker`
6. Deploy and copy the service URL

### Frontend Deployment (Vercel)

1. Create account on [Vercel.com](https://vercel.com)
2. Import GitHub repository
3. Configure:
   - **Framework Preset**: Vite
   - **Root Directory**: `frontend`
   - **Build Command**: `npm run build`
   - **Output Directory**: `dist`
4. Add environment variable:
   - `VITE_BACKEND_URL`: Your Render backend URL
5. Deploy

### Environment Variables

**Backend (Render):**
- `PORT`: Automatically set by Render

**Frontend (Vercel):**
- `VITE_BACKEND_URL`: Your Render backend URL

---

