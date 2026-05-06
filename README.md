# FinSuite by Paralux Analytics

A full-featured financial analysis terminal built with Flask.

![FinSuite](static/images/paralux_logo.png)

## Features

- **Technical Analysis** — Candlestick charts with SMA, EMA, RSI, MACD, Bollinger Bands, Stochastic, ATR, OBV. Intraday intervals from 1 minute to 4 hours. Drawing tools: horizontal lines, vertical lines, support/resistance bands, and trendlines with magnetic OHLC snap.
- **Listings Explorer** — Screener with filters for sector, market cap, P/E, momentum, RSI, 52-week range and more.
- **SEC Fundamentals** — XBRL financial data, ratio analysis, revenue/earnings trends pulled directly from SEC EDGAR.
- **Correlation Matrix** — Multi-ticker correlation heatmap with rolling window selector.
- **Macro Composite** — Multi-factor macro scoring engine combining economic indicators.
- **Economic Data** — FRED macro charts (GDP, CPI, unemployment, yield curve, etc.).
- **News & Sentiment** — Latest headlines and sentiment scoring via Polygon.io.
- **Trading Journal** — Log and review your trades with P&L tracking tied to live chart data.
- **Alerts** — Price and indicator alerts with email notifications.
- **User Accounts** — Register, login, profile management, watchlists.

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | Python 3.11 · Flask 3 |
| Data | yfinance · SEC EDGAR XBRL · FRED API · Polygon.io |
| Database | SQLite (dev) · PostgreSQL (production) |
| Frontend | Vanilla JS · Plotly.js · CSS custom properties |
| Auth | Flask-Login · Flask-Bcrypt · Flask-WTF (CSRF) |
| Deploy | Gunicorn · Railway / Render |

## Quick Start (local)

```bash
# 1. Clone
git clone https://github.com/YOUR_USERNAME/finsuite.git
cd finsuite

# 2. Create virtual environment
python3 -m venv .venv
source .venv/bin/activate       # Windows: .venv\Scripts\activate

# 3. Install dependencies
pip install -r requirements.txt

# 4. Configure environment
cp .env.example .env
# Edit .env and set your API keys

# 5. Run
flask run
# Open http://localhost:5000
```

The database is created automatically on first run at `instance/finsuite.db`.

## Deploy to Railway

1. Fork this repo on GitHub
2. Create a new project on [Railway](https://railway.app)
3. Connect your GitHub repo
4. Add environment variables in Railway dashboard:
   - `SECRET_KEY` — a long random string
   - `DATABASE_URL` — Railway provides this automatically if you add a Postgres plugin
   - `POLYGON_API_KEY` — your Polygon.io key
   - `FRED_API_KEY` — your FRED key
5. Railway auto-detects the `Procfile` and deploys

## Deploy to Render

1. Fork this repo on GitHub
2. Create a new **Web Service** on [Render](https://render.com)
3. Connect your GitHub repo
4. Set **Build Command**: `pip install -r requirements.txt`
5. Set **Start Command**: `gunicorn app:app --bind 0.0.0.0:$PORT --workers 2 --timeout 120`
6. Add environment variables (same as Railway above)

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `SECRET_KEY` | Yes | Flask session signing key |
| `DATABASE_URL` | No | Postgres URL (defaults to SQLite) |
| `POLYGON_API_KEY` | No | News & sentiment data |
| `FRED_API_KEY` | No | Macroeconomic data |

## Project Structure

```
finsuite/
├── app.py                  # Flask application (routes, models, API)
├── requirements.txt
├── Procfile                # Gunicorn entry point
├── runtime.txt             # Python version hint
├── .env.example            # Environment variable template
├── static/
│   ├── css/
│   │   └── style.css       # All styles
│   ├── js/
│   │   └── app.js          # All frontend logic
│   └── images/
└── templates/
    ├── base.html           # Layout shell
    ├── dashboard.html      # Home dashboard
    ├── module.html         # Main analysis terminal
    ├── login.html
    ├── register.html
    ├── profile.html
    └── alerts.html
```

## License

MIT
