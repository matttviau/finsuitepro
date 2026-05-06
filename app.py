"""
FinSuite — Paralux Analytics Web Application
============================================
Full-featured financial analysis terminal with:
  - User authentication (register, login, logout, profile management)
  - Technical Analysis (OHLC, SMA, EMA, RSI, MACD, Bollinger Bands, Stochastic, ATR, OBV)
  - SEC Fundamentals (XBRL data, ratio analysis)
  - Correlation Matrix
  - Economic Data (FRED API)
  - News & Sentiment (Polygon.io)
  - Composite Signal Engine
"""

import os
import sys
import re
import time
import math
import json
import secrets
from datetime import datetime, timedelta
from collections import defaultdict
from functools import wraps

import pandas as pd
import numpy as np
import requests
import yfinance as yf
from requests.adapters import HTTPAdapter, Retry

from flask import (
    Flask, render_template, redirect, url_for, flash, request,
    jsonify, session, abort
)
from flask.json.provider import DefaultJSONProvider
from flask_sqlalchemy import SQLAlchemy
from flask_login import (
    LoginManager, UserMixin, login_user, logout_user,
    login_required, current_user
)
from flask_bcrypt import Bcrypt
from flask_wtf import FlaskForm
from flask_wtf.csrf import CSRFProtect
from wtforms import StringField, PasswordField, SubmitField, BooleanField
from wtforms.validators import DataRequired, Email, Length, EqualTo, ValidationError

# ═══════════════════════════════════════════════════════════════════════════════
#  APP SETUP
# ═══════════════════════════════════════════════════════════════════════════════

class _NaNSafeProvider(DefaultJSONProvider):
    """Serialize NaN/Infinity as JSON null instead of invalid bare NaN."""
    def _clean(self, obj):
        if isinstance(obj, float) and (obj != obj or obj == float('inf') or obj == float('-inf')):
            return None
        if isinstance(obj, dict):
            return {k: self._clean(v) for k, v in obj.items()}
        if isinstance(obj, (list, tuple)):
            return [self._clean(v) for v in obj]
        return obj
    def dumps(self, obj, **kwargs):
        return super().dumps(self._clean(obj), **kwargs)

app = Flask(__name__)
app.json_provider_class = _NaNSafeProvider
app.json = _NaNSafeProvider(app)
app.config['SECRET_KEY'] = os.environ.get('SECRET_KEY', secrets.token_hex(32))

# Build database URI — prefers DATABASE_URL env var (Railway/Render Postgres).
# Falls back to SQLite stored beside this file so it works locally and on
# platforms without a persistent volume (path is absolute to avoid CWD issues).
_db_url = os.environ.get('DATABASE_URL', '')
if _db_url:
    _db_url = _db_url.replace('postgres://', 'postgresql://')  # fix legacy scheme
else:
    _instance_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'instance')
    os.makedirs(_instance_dir, exist_ok=True)
    _db_url = f"sqlite:///{os.path.join(_instance_dir, 'finsuite.db')}"

_is_postgres = _db_url.startswith('postgresql')
app.config['SQLALCHEMY_DATABASE_URI'] = _db_url
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
app.config['WTF_CSRF_TIME_LIMIT'] = None

# Connection pool settings — more robust for Postgres on Railway
if _is_postgres:
    app.config['SQLALCHEMY_ENGINE_OPTIONS'] = {
        'pool_pre_ping': True,       # verify connection before use
        'pool_recycle': 300,         # recycle connections every 5 min
        'pool_size': 5,
        'max_overflow': 10,
        'connect_args': {'connect_timeout': 10},
    }
else:
    app.config['SQLALCHEMY_ENGINE_OPTIONS'] = {
        'connect_args': {'check_same_thread': False},
    }

db      = SQLAlchemy(app)
bcrypt  = Bcrypt(app)
csrf    = CSRFProtect(app)
login_manager = LoginManager(app)
login_manager.login_view = 'login'
login_manager.login_message_category = 'info'

API_KEY      = os.environ.get('POLYGON_API_KEY', 'tnGHxeqXAnkqoV6pUL2XFjDStejcjhb2')
FRED_API_KEY = os.environ.get('FRED_API_KEY', 'fcdca4c8a04957bdcaa22c32f1e8eb34')
# ═══════════════════════════════════════════════════════════════════════════════
#  DATABASE MODELS
# ═══════════════════════════════════════════════════════════════════════════════

class User(db.Model, UserMixin):
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(80), unique=True, nullable=False)
    email = db.Column(db.String(120), unique=True, nullable=False)
    password_hash = db.Column(db.String(128), nullable=False)
    first_name = db.Column(db.String(50), default='')
    last_name = db.Column(db.String(50), default='')
    bio = db.Column(db.Text, default='')
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    last_login = db.Column(db.DateTime, default=datetime.utcnow)
    watchlist = db.Column(db.Text, default='AAPL,MSFT,GOOGL,TSLA,NVDA')
    theme = db.Column(db.String(10), default='light')

    def set_password(self, password):
        self.password_hash = bcrypt.generate_password_hash(password).decode('utf-8')

    def check_password(self, password):
        return bcrypt.check_password_hash(self.password_hash, password)

    @property
    def watchlist_list(self):
        return [t.strip().upper() for t in (self.watchlist or '').split(',') if t.strip()]


class SearchHistory(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    ticker = db.Column(db.String(10), nullable=False)
    module = db.Column(db.String(20), nullable=False)
    searched_at = db.Column(db.DateTime, default=datetime.utcnow)


class Alert(db.Model):
    id             = db.Column(db.Integer, primary_key=True)
    user_id        = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    ticker         = db.Column(db.String(10), nullable=False)
    label          = db.Column(db.String(100), default='')
    condition_type = db.Column(db.String(40), nullable=False)
    threshold      = db.Column(db.Float, nullable=True)
    priority       = db.Column(db.String(10), default='medium')  # low/medium/high/critical
    status         = db.Column(db.String(15), default='active')  # active/triggered/paused/dismissed
    created_at     = db.Column(db.DateTime, default=datetime.utcnow)
    triggered_at   = db.Column(db.DateTime, nullable=True)
    triggered_value= db.Column(db.Float, nullable=True)
    last_checked   = db.Column(db.DateTime, nullable=True)
    expires_at     = db.Column(db.DateTime, nullable=True)
    notes          = db.Column(db.Text, default='')
    repeat         = db.Column(db.Boolean, default=False)

    def to_dict(self):
        return {
            'id':              self.id,
            'ticker':          self.ticker,
            'label':           self.label or '',
            'condition_type':  self.condition_type,
            'threshold':       self.threshold,
            'priority':        self.priority,
            'status':          self.status,
            'created_at':      self.created_at.isoformat()      if self.created_at     else None,
            'triggered_at':    self.triggered_at.isoformat()    if self.triggered_at   else None,
            'triggered_value': self.triggered_value,
            'last_checked':    self.last_checked.isoformat()    if self.last_checked   else None,
            'expires_at':      self.expires_at.isoformat()      if self.expires_at     else None,
            'notes':           self.notes or '',
            'repeat':          self.repeat,
        }


class TradeJournal(db.Model):
    __tablename__ = 'trade_journal'
    id              = db.Column(db.Integer, primary_key=True)
    user_id         = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    ticker          = db.Column(db.String(20), nullable=False)
    company_name    = db.Column(db.String(100), default='')
    side            = db.Column(db.String(10),  default='long')     # long / short
    asset_type      = db.Column(db.String(20),  default='equity')   # equity/option/crypto/futures/forex
    status          = db.Column(db.String(10),  default='open')     # open / closed
    timeframe       = db.Column(db.String(20),  default='')         # 1D 4H 1W swing position
    setup_type      = db.Column(db.String(100), default='')
    entry_date      = db.Column(db.String(20),  nullable=False)
    entry_price     = db.Column(db.Float,       nullable=False)
    exit_date       = db.Column(db.String(20),  nullable=True)
    exit_price      = db.Column(db.Float,       nullable=True)
    quantity        = db.Column(db.Float,       default=1.0)
    stop_loss       = db.Column(db.Float,       nullable=True)
    take_profit     = db.Column(db.Float,       nullable=True)
    risk_reward     = db.Column(db.Float,       nullable=True)
    pnl             = db.Column(db.Float,       nullable=True)
    pnl_pct         = db.Column(db.Float,       nullable=True)
    conviction      = db.Column(db.Integer,     default=3)          # 1–5
    emotional_state = db.Column(db.String(50),  default='')
    entry_rationale = db.Column(db.Text,        default='')
    exit_rationale  = db.Column(db.Text,        default='')
    mistakes        = db.Column(db.Text,        default='')
    lessons         = db.Column(db.Text,        default='')
    tags            = db.Column(db.String(200), default='')
    created_at      = db.Column(db.DateTime,    default=datetime.utcnow)
    updated_at      = db.Column(db.DateTime,    default=datetime.utcnow)

    def _recompute(self):
        """Recompute P&L and R:R from stored fields."""
        if self.exit_price is not None and self.entry_price:
            mult = 1 if self.side == 'long' else -1
            self.pnl     = round((self.exit_price - self.entry_price) * mult * (self.quantity or 1), 4)
            self.pnl_pct = round((self.exit_price - self.entry_price) / self.entry_price * mult * 100, 4)
        else:
            self.pnl = self.pnl_pct = None
        if self.stop_loss and self.take_profit and self.entry_price:
            risk   = abs(self.entry_price - self.stop_loss)
            reward = abs(self.take_profit - self.entry_price)
            self.risk_reward = round(reward / risk, 2) if risk > 0 else None
        else:
            self.risk_reward = None

    def to_dict(self):
        return {
            'id':              self.id,
            'ticker':          self.ticker,
            'company_name':    self.company_name or '',
            'side':            self.side,
            'asset_type':      self.asset_type,
            'status':          self.status,
            'timeframe':       self.timeframe or '',
            'setup_type':      self.setup_type or '',
            'entry_date':      self.entry_date,
            'entry_price':     self.entry_price,
            'exit_date':       self.exit_date,
            'exit_price':      self.exit_price,
            'quantity':        self.quantity,
            'stop_loss':       self.stop_loss,
            'take_profit':     self.take_profit,
            'risk_reward':     self.risk_reward,
            'pnl':             self.pnl,
            'pnl_pct':         self.pnl_pct,
            'conviction':      self.conviction,
            'emotional_state': self.emotional_state or '',
            'entry_rationale': self.entry_rationale or '',
            'exit_rationale':  self.exit_rationale or '',
            'mistakes':        self.mistakes or '',
            'lessons':         self.lessons or '',
            'tags':            self.tags or '',
            'created_at':      self.created_at.isoformat() if self.created_at else None,
            'updated_at':      self.updated_at.isoformat() if self.updated_at else None,
        }


@login_manager.user_loader
def load_user(user_id):
    return db.session.get(User, int(user_id))


# ═══════════════════════════════════════════════════════════════════════════════
#  FORMS
# ═══════════════════════════════════════════════════════════════════════════════

class RegistrationForm(FlaskForm):
    username = StringField('Username', validators=[DataRequired(), Length(min=3, max=80)])
    email = StringField('Email', validators=[DataRequired(), Email()])
    password = PasswordField('Password', validators=[DataRequired(), Length(min=6)])
    confirm_password = PasswordField('Confirm Password', validators=[DataRequired(), EqualTo('password')])
    submit = SubmitField('Create Account')

    def validate_username(self, username):
        user = User.query.filter_by(username=username.data).first()
        if user:
            raise ValidationError('Username already taken.')

    def validate_email(self, email):
        user = User.query.filter_by(email=email.data).first()
        if user:
            raise ValidationError('Email already registered.')


class LoginForm(FlaskForm):
    email = StringField('Email', validators=[DataRequired(), Email()])
    password = PasswordField('Password', validators=[DataRequired()])
    remember = BooleanField('Remember Me')
    submit = SubmitField('Sign In')


class ProfileForm(FlaskForm):
    username = StringField('Username', validators=[DataRequired(), Length(min=3, max=80)])
    email = StringField('Email', validators=[DataRequired(), Email()])
    first_name = StringField('First Name', validators=[Length(max=50)])
    last_name = StringField('Last Name', validators=[Length(max=50)])
    bio = StringField('Bio', validators=[Length(max=500)])
    watchlist = StringField('Watchlist (comma-separated)')
    submit = SubmitField('Update Profile')


class ChangePasswordForm(FlaskForm):
    current_password = PasswordField('Current Password', validators=[DataRequired()])
    new_password = PasswordField('New Password', validators=[DataRequired(), Length(min=6)])
    confirm_password = PasswordField('Confirm New Password', validators=[DataRequired(), EqualTo('new_password')])
    submit = SubmitField('Change Password')


# ═══════════════════════════════════════════════════════════════════════════════
#  DATA BACKENDS (preserved from original)
# ═══════════════════════════════════════════════════════════════════════════════

def _polygon_session():
    s = requests.Session()
    retries = Retry(total=3, backoff_factor=0.4,
                    status_forcelist=[429, 500, 502, 503, 504],
                    allowed_methods=["GET"])
    s.mount("https://", HTTPAdapter(max_retries=retries))
    return s

_SESSION = _polygon_session()
_FRED_SESSION = _polygon_session()


# Per-session cache: ticker.upper() → full-history DataFrame (split/div adjusted).
# Each unique ticker costs exactly one yfinance network call per server session;
# subsequent requests for the same ticker (different period, backtest, alerts…)
# are served instantly from memory.
_YF_CACHE: dict = {}
_YF_INTRADAY_CACHE: dict = {}   # (sym, interval, period_str) → (df, fetched_at)
_MACRO_CACHE: dict = {}         # FRED macro series cache keyed by series_id


def fetch_ohlc(ticker: str, days: int = 730) -> pd.DataFrame:
    """
    Fetch daily OHLCV data via yfinance (Yahoo Finance).

    - Close column is the split- and dividend-adjusted close so all
      technical indicators and backtests work on a continuous price series.
    - Full history is downloaded once and cached in _YF_CACHE; slicing
      by `days` is done in memory — no extra network calls.
    - days=0  → return the complete available history.
    - days>0  → return only the most recent `days` calendar days.
    - Raises ValueError with a clear message on bad ticker or empty data.
    """
    sym = ticker.upper()

    if sym not in _YF_CACHE:
        tk = yf.Ticker(sym)
        df_full = tk.history(period="max", auto_adjust=True, actions=False)

        if df_full.empty:
            raise ValueError(
                f"No price data found for '{sym}'. "
                "Check the ticker symbol — yfinance uses Yahoo Finance symbols "
                "(e.g. BRK-B, BTC-USD, AAPL)."
            )

        # Normalise: drop timezone so index is plain date, keep OHLCV only
        df_full.index = df_full.index.tz_localize(None) if df_full.index.tzinfo is not None \
                        else df_full.index
        df_full.index.name = "date"
        df_full = df_full[["Open", "High", "Low", "Close", "Volume"]].sort_index()
        df_full = df_full.dropna(subset=["Close"])

        _YF_CACHE[sym] = df_full

    df_full = _YF_CACHE[sym]

    if days == 0:
        return df_full.copy()

    cutoff = pd.Timestamp.today().normalize() - pd.Timedelta(days=days)
    sliced = df_full[df_full.index >= cutoff]
    if sliced.empty:
        # Requested window older than available history — return everything
        return df_full.copy()
    return sliced.copy()


def fetch_ohlc_intraday(ticker: str, interval: str, period_str: str) -> pd.DataFrame:
    """
    Fetch intraday OHLCV via yfinance for sub-daily intervals.

    Supported intervals : '1m','2m','5m','15m','30m','60m','1h','4h'
    '4h' is synthesised by resampling '1h' data.

    Results are cached with a short TTL (2 min for 1m, 5 min for others)
    so rapid period/interval switches don't hammer the API.
    """
    sym           = ticker.upper()
    real_interval = '1h' if interval == '4h' else interval
    cache_key     = (sym, interval, period_str)
    now           = time.time()
    ttl           = 120 if interval == '1m' else 300

    if cache_key in _YF_INTRADAY_CACHE:
        cached_df, cached_at = _YF_INTRADAY_CACHE[cache_key]
        if now - cached_at < ttl:
            return cached_df.copy()

    try:
        tk_obj = yf.Ticker(sym)
        df = tk_obj.history(period=period_str, interval=real_interval,
                            auto_adjust=True, actions=False)
        if df.empty:
            raise ValueError(
                f"No intraday data for '{sym}' "
                f"(interval={interval}, period={period_str}). "
                "Note: yfinance limits 1m data to the last 7 days and "
                "5m–30m data to the last 60 days."
            )
        # Normalise timezone → tz-naive
        if df.index.tzinfo is not None:
            df.index = df.index.tz_localize(None)
        df.index.name = 'datetime'
        df = df[['Open', 'High', 'Low', 'Close', 'Volume']].dropna(subset=['Close'])

        # Resample 1h → 4h
        if interval == '4h':
            df = df.resample('4h').agg(
                Open=('Open', 'first'), High=('High', 'max'),
                Low=('Low',  'min'),   Close=('Close', 'last'),
                Volume=('Volume', 'sum')
            ).dropna(subset=['Close'])

        _YF_INTRADAY_CACHE[cache_key] = (df.copy(), now)
        return df.copy()
    except Exception as e:
        raise ValueError(str(e))


def fetch_latest_price(ticker: str) -> dict:
    # Try Polygon snapshot first
    url = (
        f"https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers/{ticker.upper()}"
        f"?apiKey={API_KEY}"
    )
    try:
        r = _SESSION.get(url, headers={"User-Agent": "FinSuitePro/3.0"}, timeout=10)
        if r.status_code == 200:
            data = r.json().get("ticker", {})
            day = data.get("day", {})
            prev = data.get("prevDay", {})
            close = day.get("c") or prev.get("c")
            if close:
                open_ = day.get("o") or prev.get("o", close)
                chg = round(close - open_, 2) if open_ else 0
                pct = round(chg / open_ * 100, 2) if open_ else 0
                return {"close": round(close, 2), "chg": chg, "pct": pct,
                        "high": round(day.get("h") or prev.get("h", close), 2),
                        "low":  round(day.get("l") or prev.get("l", close), 2),
                        "volume": int(day.get("v") or prev.get("v", 0))}
    except Exception:
        pass

    # Fallback: derive from OHLC history
    try:
        df = fetch_ohlc(ticker, days=5)
        if not df.empty:
            last = df.iloc[-1]
            prev_close = float(df.iloc[-2]["Close"]) if len(df) > 1 else float(last["Close"])
            close = round(float(last["Close"]), 2)
            chg   = round(close - prev_close, 2)
            pct   = round(chg / prev_close * 100, 2) if prev_close else 0
            return {"close": close, "chg": chg, "pct": pct,
                    "high":   round(float(last["High"]), 2),
                    "low":    round(float(last["Low"]), 2),
                    "volume": int(last["Volume"])}
    except Exception:
        pass

    return {}


def fetch_news(ticker: str, limit: int = 50) -> list:
    url = (
        "https://api.polygon.io/v2/reference/news"
        f"?ticker={ticker.upper()}&order=desc&sort=published_utc"
        f"&limit={limit}&apiKey={API_KEY}"
    )
    try:
        r = _SESSION.get(url, headers={"User-Agent": "FinSuitePro/3.0"}, timeout=15)
        r.raise_for_status()
        return r.json().get("results", [])
    except Exception:
        return []


def parse_sentiment(articles: list, ticker: str) -> pd.DataFrame:
    POSITIVE_KW = {"surge", "soar", "beat", "record", "profit", "gain", "rally",
                   "upgrade", "buy", "growth", "strong", "rise", "positive",
                   "bullish", "outperform", "boost", "expand", "launch"}
    NEGATIVE_KW = {"fall", "drop", "miss", "loss", "decline", "cut", "downgrade",
                   "sell", "weak", "risk", "crash", "plunge", "lawsuit", "recall",
                   "bearish", "underperform", "concern", "warn", "layoff", "fraud"}
    rows = []
    sym = ticker.upper()
    for art in articles:
        pub_raw = art.get("published_utc", "")
        try:
            pub = datetime.fromisoformat(pub_raw.replace("Z", "+00:00"))
        except Exception:
            pub = None
        title = art.get("title", "")
        desc = art.get("description", "")
        publisher = art.get("publisher", {}).get("name", "Unknown")
        url_ = art.get("article_url", "")
        insights = art.get("insights") or []
        matched = [i for i in insights if isinstance(i, dict)
                   and i.get("ticker", "").upper() == sym]
        if matched:
            for ins in matched:
                raw_sent = ins.get("sentiment", "neutral").lower()
                reasoning = ins.get("sentiment_reasoning", "")
                score = {"positive": 1, "negative": -1}.get(raw_sent, 0)
                rows.append(dict(published=pub, title=title, publisher=publisher,
                                 sentiment=raw_sent, score=score,
                                 reasoning=reasoning, url=url_))
        else:
            text = (title + " " + desc).lower()
            words = set(text.split())
            pos = len(words & POSITIVE_KW)
            neg = len(words & NEGATIVE_KW)
            if pos > neg:
                raw_sent, score = "positive", 1
            elif neg > pos:
                raw_sent, score = "negative", -1
            else:
                raw_sent, score = "neutral", 0
            rows.append(dict(published=pub, title=title, publisher=publisher,
                             sentiment=raw_sent, score=score,
                             reasoning="(keyword heuristic)",
                             url=url_))
    df = pd.DataFrame(rows)
    if not df.empty and "published" in df.columns:
        df.sort_values("published", ascending=False, inplace=True)
        df.reset_index(drop=True, inplace=True)
    return df


def compute_indicators(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    df["SMA_20"]  = df["Close"].rolling(20).mean()
    df["SMA_50"]  = df["Close"].rolling(50).mean()
    df["SMA_200"] = df["Close"].rolling(200).mean()
    df["EMA_20"]  = df["Close"].ewm(span=20, adjust=False).mean()
    df["EMA_9"]   = df["Close"].ewm(span=9,  adjust=False).mean()
    # Rolling VWAP (20-session price×volume / cumulative volume)
    df["VWAP"]    = (df["Close"] * df["Volume"]).rolling(20).sum() / df["Volume"].rolling(20).sum()
    delta = df["Close"].diff()
    gain = delta.clip(lower=0).rolling(14).mean()
    loss = (-delta.clip(upper=0)).rolling(14).mean()
    df["RSI"] = 100 - (100 / (1 + gain / loss))
    e1 = df["Close"].ewm(span=12, adjust=False).mean()
    e2 = df["Close"].ewm(span=26, adjust=False).mean()
    df["MACD"] = e1 - e2
    df["MACD_signal"] = df["MACD"].ewm(span=9, adjust=False).mean()
    df["MACD_hist"] = df["MACD"] - df["MACD_signal"]
    sma20 = df["Close"].rolling(20).mean()
    std20 = df["Close"].rolling(20).std()
    df["BB_upper"] = sma20 + 2 * std20
    df["BB_lower"] = sma20 - 2 * std20
    df["BB_mid"] = sma20
    df["BB_width"] = (df["BB_upper"] - df["BB_lower"]) / df["BB_mid"]
    low14 = df["Low"].rolling(14).min()
    high14 = df["High"].rolling(14).max()
    df["Stoch_K"] = 100 * (df["Close"] - low14) / (high14 - low14)
    df["Stoch_D"] = df["Stoch_K"].rolling(3).mean()
    df["TR"] = np.maximum(
        df["High"] - df["Low"],
        np.maximum(
            (df["High"] - df["Close"].shift()).abs(),
            (df["Low"] - df["Close"].shift()).abs()
        )
    )
    df["ATR"] = df["TR"].rolling(14).mean()
    c = df["Close"]
    direction = np.sign(c.diff()).fillna(0)
    df["OBV"] = (direction * df["Volume"]).cumsum()
    df["Return"] = df["Close"].pct_change()
    return df


# ── Alert condition evaluator ──────────────────────────────────────────────

def _check_alert_condition(alert, df: pd.DataFrame):
    """Return (triggered: bool, current_value: float|None)."""
    if len(df) < 2:
        return False, None
    c     = df.iloc[-1]
    prev  = df.iloc[-2]
    ct    = alert.condition_type
    th    = float(alert.threshold) if alert.threshold is not None else 0.0
    price = float(c['Close'])

    def _safe(col, row=None):
        row = row if row is not None else c
        v = row.get(col) if hasattr(row, 'get') else getattr(row, col, None)
        return None if (v is None or (isinstance(v, float) and math.isnan(v))) else float(v)

    if ct == 'price_above':
        return price >= th, price
    if ct == 'price_below':
        return price <= th, price
    if ct == 'pct_change_above':
        p0 = float(prev['Close'])
        pct = (price - p0) / p0 * 100 if p0 else 0
        return pct >= th, round(pct, 3)
    if ct == 'pct_change_below':
        p0 = float(prev['Close'])
        pct = (price - p0) / p0 * 100 if p0 else 0
        return pct <= -abs(th), round(pct, 3)
    if ct == 'rsi_above':
        rsi = _safe('RSI')
        return (rsi is not None and rsi >= th), rsi
    if ct == 'rsi_below':
        rsi = _safe('RSI')
        return (rsi is not None and rsi <= th), rsi
    if ct == 'macd_bull_cross':
        mn, sn = _safe('MACD'), _safe('MACD_signal')
        mp, sp = _safe('MACD', prev), _safe('MACD_signal', prev)
        if None in (mn, sn, mp, sp): return False, None
        return (mp <= sp) and (mn > sn), round(mn - sn, 4)
    if ct == 'macd_bear_cross':
        mn, sn = _safe('MACD'), _safe('MACD_signal')
        mp, sp = _safe('MACD', prev), _safe('MACD_signal', prev)
        if None in (mn, sn, mp, sp): return False, None
        return (mp >= sp) and (mn < sn), round(mn - sn, 4)
    if ct == 'bb_upper_break':
        bbu = _safe('BB_upper')
        return (bbu is not None and price >= bbu), round(price - bbu, 3) if bbu else None
    if ct == 'bb_lower_break':
        bbl = _safe('BB_lower')
        return (bbl is not None and price <= bbl), round(price - bbl, 3) if bbl else None
    if ct == 'volume_spike':
        vol     = float(c['Volume'])
        avg_vol = df['Volume'].rolling(20).mean().iloc[-1]
        ratio   = vol / float(avg_vol) if avg_vol and avg_vol > 0 else 0
        return ratio >= th, round(ratio, 2)
    if ct == 'new_52w_high':
        n = min(252, len(df))
        h52 = float(df['Close'].rolling(n).max().iloc[-1])
        return price >= h52, price
    if ct == 'new_52w_low':
        n = min(252, len(df))
        l52 = float(df['Close'].rolling(n).min().iloc[-1])
        return price <= l52, price
    if ct == 'sma50_cross_above':
        sn, sp = _safe('SMA_50'), _safe('SMA_50', prev)
        pp = float(prev['Close'])
        if None in (sn, sp): return False, None
        return (pp <= sp) and (price > sn), round(price - sn, 3)
    if ct == 'sma50_cross_below':
        sn, sp = _safe('SMA_50'), _safe('SMA_50', prev)
        pp = float(prev['Close'])
        if None in (sn, sp): return False, None
        return (pp >= sp) and (price < sn), round(price - sn, 3)
    if ct == 'sma200_cross_above':
        sn, sp = _safe('SMA_200'), _safe('SMA_200', prev)
        pp = float(prev['Close'])
        if None in (sn, sp): return False, None
        return (pp <= sp) and (price > sn), round(price - sn, 3)
    if ct == 'sma200_cross_below':
        sn, sp = _safe('SMA_200'), _safe('SMA_200', prev)
        pp = float(prev['Close'])
        if None in (sn, sp): return False, None
        return (pp >= sp) and (price < sn), round(price - sn, 3)
    return False, None


# ── SEC / Fundamental Data ─────────────────────────────────────────────────

class FundamentalData:
    SEC_TICKERS_URL = "https://www.sec.gov/files/company_tickers.json"
    SEC_FACTS_URL = "https://data.sec.gov/api/xbrl/companyfacts/CIK{cik}.json"
    HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; FinSuitePro/3.0; contact@example.com)"}

    def __init__(self):
        self._session = _polygon_session()
        self._last_ts = 0.0
        self._ticker_map = None

    def _throttle(self, gap=0.5):
        elapsed = time.time() - self._last_ts
        if elapsed < gap:
            time.sleep(gap - elapsed)
        self._last_ts = time.time()

    def _get(self, url):
        self._throttle()
        r = self._session.get(url, headers=self.HEADERS, timeout=20)
        if r.status_code == 404:
            return {}
        r.raise_for_status()
        return r.json()

    def resolve_cik(self, ticker):
        if self._ticker_map is None:
            raw = self._get(self.SEC_TICKERS_URL)
            self._ticker_map = {v["ticker"].upper(): v["cik_str"] for v in raw.values()}
        sym = ticker.upper()
        if sym not in self._ticker_map:
            raise ValueError(f"Ticker '{sym}' not found in SEC EDGAR.")
        return int(self._ticker_map[sym])

    def get_facts(self, ticker):
        cik = self.resolve_cik(ticker)
        return self._get(self.SEC_FACTS_URL.format(cik=str(cik).zfill(10)))

    def get_line_items(self, facts):
        items = []
        for taxonomy, entries in facts.get("facts", {}).items():
            if isinstance(entries, dict):
                items.extend(entries.keys())
        return sorted(list(dict.fromkeys(items)))

    def get_series(self, facts, line_item):
        frames = []
        for taxonomy, entries in facts.get("facts", {}).items():
            if isinstance(entries, dict) and line_item in entries:
                for unit, records in entries[line_item].get("units", {}).items():
                    frame = pd.DataFrame(records)
                    frame["unit"] = unit
                    frames.append(frame)
        if not frames:
            return pd.DataFrame()
        df = pd.concat(frames, ignore_index=True)
        df.rename(columns={"val": line_item, "end": "period_end"}, inplace=True)
        for col in ("filed", "period_end"):
            if col in df.columns:
                df[col] = pd.to_datetime(df[col], errors="coerce")
        if "start" in df.columns:
            df["start"] = pd.to_datetime(df["start"], errors="coerce")
            df["period_days"] = (df["period_end"] - df["start"]).dt.days
            mask = df["period_days"].between(60, 105) | df["period_days"].between(340, 380)
            df = df[mask].copy()
        if "filed" in df.columns and not df.empty:
            df = df.sort_values("filed").drop_duplicates(subset=["period_end"], keep="last")
        if not df.empty and "period_end" in df.columns:
            df = df.sort_values("period_end").reset_index(drop=True)
            def _ql(ts):
                if pd.isna(ts): return ""
                return f"Q{(ts.month - 1) // 3 + 1} {ts.year}"
            df["quarter_label"] = df["period_end"].apply(_ql)
        return df


_FD = FundamentalData()

# ── Filing Analysis — local engine (no external API) ────────────────────────

_SEC_POS_WORDS = frozenset([
    'growth','grew','grow','increase','increased','increasing','improved','improvement',
    'strong','stronger','record','exceeded','beat','expansion','expanding','profitable',
    'profitability','gain','gains','positive','opportunity','opportunities','momentum',
    'robust','solid','favorable','success','achieved','higher','advance','advancing',
    'recovery','recovering','outperform','accelerated','surge','surged','ahead',
    'excellent','outstanding','best','highest','leading','raised','raising',
    'exceeded','outperformed','delivered','generated','returned','launched',
])

_SEC_NEG_WORDS = frozenset([
    'decline','declined','declining','decrease','decreased','decreasing','loss','losses',
    'uncertain','uncertainty','headwind','challenge','challenging','difficult','difficulty',
    'weak','weakness','below','miss','missed','concern','concerning','adverse','adversely',
    'negative','volatile','volatility','deteriorat','impairment','writedown','write-down',
    'restructur','lawsuit','litigation','penalty','penalties','fine','default','covenant',
    'inflation','recession','slowdown','pressure','pressures','lower','reduced','reduce',
    'contraction','downturn','cautious','shortage','disruption','risk','risks',
    'terminated','failed','suspended','delayed','discontinued','divest',
])


def _extract_filing_text(html_content):
    """Strip HTML/XBRL tags and normalise whitespace from an EDGAR document."""
    html_content = re.sub(
        r'<(script|style|ix:[^>\s]*)[^>]*>.*?</(script|style|ix:[^>\s]*)>',
        ' ', html_content, flags=re.DOTALL | re.IGNORECASE
    )
    text = re.sub(r'<[^>]+>', ' ', html_content)
    for ent, ch in [('&amp;','&'),('&lt;','<'),('&gt;','>'),
                    ('&nbsp;',' '),('&#160;',' '),('&quot;','"'),('&#39;',"'")]:
        text = text.replace(ent, ch)
    lines = [l.strip() for l in text.splitlines() if len(l.strip()) > 40]
    return ' '.join(lines)


def _sec_extract_sections(text):
    """Locate standard EDGAR ITEM sections; return dict name→text snippet."""
    t = re.sub(r'\s+', ' ', text)
    marks = [
        ('business',     r'ITEM\s*1[\s.]+BUSINESS\b'),
        ('risk_factors', r'ITEM\s*1A[\s.]+RISK\s+FACTORS'),
        ('properties',   r'ITEM\s*2[\s.]+PROPERTIES'),
        ('legal',        r'ITEM\s*3[\s.]+LEGAL\s+PROCEEDINGS'),
        ('mda',          r"ITEM\s*7[\s.]+MANAGEMENT(?:'?S)?\s+DISCUSSION"),
        ('quantitative', r'ITEM\s*7A[\s.]+QUANTITATIVE'),
        ('financials',   r'ITEM\s*8[\s.]+FINANCIAL\s+STATEMENTS'),
        ('controls',     r'ITEM\s*9A[\s.]+CONTROLS'),
    ]
    positions = []
    for name, pat in marks:
        m = re.search(pat, t, re.IGNORECASE)
        if m:
            positions.append((m.start(), name, m.end()))
    positions.sort()
    sections = {}
    for i, (_, name, mend) in enumerate(positions):
        nxt = positions[i + 1][0] if i + 1 < len(positions) else len(t)
        sections[name] = t[mend:min(nxt, mend + 34000)].strip()
    return sections


def _sec_clean_sentence(text):
    """Normalise a raw sentence into clean, readable natural language."""
    # Decode common leftover entities
    for ent, ch in [('&amp;','&'),('&lt;','<'),('&gt;','>'),('&nbsp;',' '),
                    ('&#160;',' '),('&quot;','"'),('&#39;',"'")]:
        text = text.replace(ent, ch)
    # Normalise typographic characters
    text = text.replace('\u2019',"'").replace('\u2018',"'")
    text = text.replace('\u201c','"').replace('\u201d','"')
    text = text.replace('\u2013',' - ').replace('\u2014',' - ')
    text = text.replace('\u00a0',' ').replace('\u200b','')
    # Remove bullet/arrow/decorative symbols
    text = re.sub(r'[•·▪▸►▶→↑↓↔◦‣⁃∙◆◇○●□■★☆✓✗✦✧†‡§¶©®™°]', '', text)
    # Strip control characters
    text = re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]', '', text)
    # Collapse whitespace
    text = re.sub(r'\s+', ' ', text).strip()
    # Strip leading junk characters (commas, semicolons, dashes, dots, pipes)
    text = re.sub(r'^[\s,;:\|\/\-–—._()\[\]]+', '', text)
    # Strip trailing junk (keep final sentence punctuation)
    text = re.sub(r'[\s,;:\|\/\-–—_()\[\]]+$', '', text)
    if text and text[-1] not in '.!?':
        text += '.'
    return text.strip()


def _sec_sentences(text, max_len=360):
    """Split text into clean, natural-language sentences."""
    raw = re.split(r'(?<=[.!?])\s+', text)
    out = []
    for s in raw:
        s = _sec_clean_sentence(s.strip())
        if len(s) < 42 or len(s) > max_len:
            continue
        # Reject if fewer than 40 % of chars are letters (table data / ticker noise)
        alpha = sum(1 for c in s if c.isalpha())
        if alpha / len(s) < 0.40:
            continue
        # Reject if the sentence starts with a bare number or single letter/symbol
        if re.match(r'^[\d$%\(\[\-]+\s', s):
            continue
        out.append(s)
    return out


def _sec_tag_sentence(sentence):
    """Return 'positive', 'negative', or 'neutral' for a single sentence."""
    words = re.findall(r'\b[a-z]+\b', sentence.lower())
    pos = sum(1 for w in words if w in _SEC_POS_WORDS)
    neg = sum(1 for w in words if w in _SEC_NEG_WORDS)
    if pos > neg:   return 'positive'
    if neg > pos:   return 'negative'
    return 'neutral'


def _sec_has_figure(sentence):
    """True if the sentence contains a dollar amount or percentage."""
    return bool(re.search(r'\$[\d,.]|\b\d[\d,.]+\s*(?:billion|million|thousand)\b|'
                          r'\b\d+(?:\.\d+)?\s*%', sentence, re.IGNORECASE))


def _sec_compute_sentiment(text):
    """Aggregate keyword-frequency sentiment; returns (label, score 1–10)."""
    words = re.findall(r'\b[a-z]+\b', text.lower()[:24000])
    pos   = sum(1 for w in words if w in _SEC_POS_WORDS)
    neg   = sum(1 for w in words if w in _SEC_NEG_WORDS)
    total = pos + neg or 1
    ratio = pos / total
    if ratio >= 0.58:   label, score = 'positive', int(round(6 + ratio * 4))
    elif ratio <= 0.42: label, score = 'negative', int(round(1 + ratio * 5))
    else:               label, score = 'neutral',  5
    return label, max(1, min(10, score))


def _sec_extract_figures(text):
    """Regex-match named financial figures from filing text."""
    t = re.sub(r'\s+', ' ', text[:34000])
    figures = {}
    searches = [
        ('revenue', [
            r'(?:revenue|net\s+sales?|total\s+revenues?)[^$\n]{0,60}?\$([\d,.]+)\s*(billion|million|thousand)?',
            r'\$([\d,.]+)\s*(billion|million|thousand)?\s*(?:in\s+(?:net\s+)?(?:revenue|sales))',
        ], 1, 2),
        ('net_income', [
            r'net\s+(?:income|earnings)[^$\n]{0,60}?\$([\d,.]+)\s*(billion|million|thousand)?',
            r'net\s+(?:income|earnings)\s+of\s+\$([\d,.]+)\s*(billion|million|thousand)?',
        ], 1, 2),
        ('operating_income', [
            r'(?:operating\s+income|income\s+from\s+operations)[^$\n]{0,60}?\$([\d,.]+)\s*(billion|million|thousand)?',
        ], 1, 2),
        ('eps', [
            r'(?:diluted\s+)?(?:earnings|loss)\s+per\s+(?:diluted\s+)?share[^$\n]{0,60}?\$([\d,.]+)',
            r'\$([\d,.]+)\s+per\s+(?:diluted\s+)?share',
        ], 1, None),
        ('free_cash_flow', [
            r'free\s+cash\s+flow[^$\n]{0,60}?\$([\d,.]+)\s*(billion|million|thousand)?',
        ], 1, 2),
        ('cash', [
            r'cash\s+and\s+cash\s+equivalents[^$\n]{0,60}?\$([\d,.]+)\s*(billion|million|thousand)?',
        ], 1, 2),
        ('total_assets', [
            r'total\s+assets[^$\n]{0,60}?\$([\d,.]+)\s*(billion|million|thousand)?',
        ], 1, 2),
        ('long_term_debt', [
            r'long.?term\s+debt[^$\n]{0,60}?\$([\d,.]+)\s*(billion|million|thousand)?',
        ], 1, 2),
        ('gross_profit', [
            r'gross\s+(?:profit|margin)[^$\n]{0,60}?\$([\d,.]+)\s*(billion|million|thousand)?',
        ], 1, 2),
    ]
    for key, patterns, vg, ug in searches:
        for pat in patterns:
            m = re.search(pat, t, re.IGNORECASE)
            if m:
                unit = (m.group(ug) if ug and m.lastindex >= ug else '') or ''
                formatted = f'${m.group(vg)} {unit}'.strip()
                figures[key] = {'formatted': formatted, 'unit': unit.lower()}
                break
    # Margin % passes
    for mkey, mpat, mlabel in [
        ('gross_margin',     r'gross\s+margin[^%\n]{0,60}?(\d+(?:\.\d+)?)\s*%',     'Gross Margin %'),
        ('operating_margin', r'operating\s+margin[^%\n]{0,60}?(\d+(?:\.\d+)?)\s*%', 'Operating Margin %'),
        ('net_margin',       r'net\s+(?:profit\s+)?margin[^%\n]{0,60}?(\d+(?:\.\d+)?)\s*%', 'Net Margin %'),
    ]:
        m = re.search(mpat, t, re.IGNORECASE)
        if m:
            figures[mkey] = {'formatted': f"{m.group(1)}%", 'unit': '%', 'label': mlabel}
    return figures


# ── Business Profile extraction ───────────────────────────────────────────
# Answers: "What does this company do? What products/services, markets, segments?"

_BIZ_CONTENT_KW = re.compile(
    r'\b(?:product|service|platform|solution|software|hardware|device|'
    r'content|application|subscript|customer|client|user|consumer|'
    r'market|industry|segment|division|category|channel|partner|'
    r'revenue|licens|sell|distribut|manufactur|'
    r'develop|provide|offer|deliver|brand|portfolio|geographic|region|'
    r'compet|advantage|position|leader|technolog|innovat|'
    r'network|infrastructure|ecosystem|integrat)\b',
    re.IGNORECASE,
)
_BIZ_BOILERPLATE = re.compile(
    r'\b(?:incorporated|organized under|principal (?:executive )?office|'
    r'pursuant to|herein by reference|annual report|filed with the|'
    r'see note|see item|refer to|described elsewhere|'
    r'forward.looking|safe harbor|cautionary)\b',
    re.IGNORECASE,
)


def _sec_extract_business_profile(sections):
    """Descriptive sentences from Item 1 (Business) about what the company does:
    products, services, markets, segments, customers, and competitive position.
    No financial figure required — this is descriptive content."""
    chunk = sections.get('business', '')
    if not chunk:
        return []

    items, seen = [], set()
    for s in _sec_sentences(chunk[:22000], max_len=520):
        key = s[:45]
        if key in seen or _BIZ_BOILERPLATE.search(s):
            continue
        if not _BIZ_CONTENT_KW.search(s):
            continue
        seen.add(key)
        items.append({
            'text':        s,
            'has_figure':  _sec_has_figure(s),
            'section':     'Business',
            'section_key': 'business',
        })
        if len(items) >= 50:
            break
    return items


# ── Financial performance extraction ──────────────────────────────────────
# Answers: "How did they perform? Revenue, margins, segment results, YoY changes?"

_PERF_FIN_KW = re.compile(
    r'\b(?:revenue|net\s+(?:income|sales|revenue)|sales|earnings|'
    r'gross\s+(?:profit|margin)|operating\s+(?:income|margin|loss)|'
    r'cash\s+(?:flow|and\s+cash)|free\s+cash|income\s+from|'
    r'expense|cost\s+of|research\s+and\s+development|'
    r'segment|quarter(?:ly)?|fiscal|year.?over.?year|'
    r'increased?|decreased?|grew|declined?|compared)\b',
    re.IGNORECASE,
)


def _sec_extract_financial_performance(sections):
    """Revenue, margin, segment, and YoY discussion sentences from MD&A.
    Any sentence with a financial keyword AND a dollar/percent figure qualifies."""
    sources = [
        ('MD&A',                 'mda',        sections.get('mda', '')),
        ('Financial Statements', 'financials', sections.get('financials', '')[:12000]),
    ]

    items, seen = [], set()
    for label, sec_key, chunk in sources:
        if not chunk:
            continue
        for s in _sec_sentences(chunk, max_len=520):
            key = s[:45]
            if key in seen:
                continue
            if not (_PERF_FIN_KW.search(s) and _sec_has_figure(s)):
                continue
            seen.add(key)
            items.append({
                'text':        s,
                'has_figure':  True,
                'section':     label,
                'section_key': sec_key,
                'sentiment':   _sec_tag_sentence(s),
            })
            if len(items) >= 60:
                return items
    return items


# ── Strategy & outlook extraction ─────────────────────────────────────────
# Answers: "What is the company planning? Growth initiatives, strategic priorities, guidance?"

_STRAT_KW = re.compile(
    r'\b(?:strateg|initiative|priorit|invest|expand|grow|develop|'
    r'launch|introduc|acqui|partner|innovat|transform|'
    r'we (?:expect|anticipate|believe|plan|intend|will|continue|remain|focus)|'
    r'going forward|outlook|guidance|forecast|target|'
    r'next (?:year|quarter|fiscal|phase)|remainder of|'
    r'long.?term|future (?:growth|plan|goal|strategy|opportunity)|'
    r'focus (?:on|areas)|key (?:priority|initiative|objective|driver)|'
    r'capital (?:allocation|return|investment)|'
    r'research\s+and\s+development|new\s+(?:product|service|market|customer))\b',
    re.IGNORECASE,
)
_STRAT_BOILERPLATE = re.compile(
    r'\b(?:forward.looking statement|actual results may differ|'
    r'safe harbor|cautionary note|sec filing|annual report on form|'
    r'pursuant to|in accordance with|risk factor)\b',
    re.IGNORECASE,
)


def _sec_extract_strategy_outlook(sections):
    """Strategic initiatives, growth plans, and forward-looking statements
    from Business and MD&A sections. Returns {text, has_figure, section, section_key}."""
    sources = [
        ('Business', 'business', sections.get('business', '')[:18000]),
        ('MD&A',     'mda',      sections.get('mda', '')),
    ]

    items, seen = [], set()
    for label, sec_key, chunk in sources:
        if not chunk:
            continue
        for s in _sec_sentences(chunk, max_len=500):
            key = s[:45]
            if key in seen or _STRAT_BOILERPLATE.search(s):
                continue
            if not _STRAT_KW.search(s):
                continue
            seen.add(key)
            items.append({
                'text':        s,
                'has_figure':  _sec_has_figure(s),
                'section':     label,
                'section_key': sec_key,
            })
            if len(items) >= 50:
                return items
    return items


# ── Risk factors extraction ────────────────────────────────────────────────

_RISK_CATS = [
    ('Cybersecurity',  r'\bcyber(?:security|attack|threat|incident)?'),
    ('Regulatory',     r'\bregulat(?:ion|ory|ed|ory\s+requirement)'),
    ('Competition',    r'\bcompetit(?:ion|ive|or|ors)'),
    ('Macroeconomic',  r'\b(?:macroeconomic|recession|inflation|interest\s+rate|economic\s+downturn|monetary)'),
    ('Liquidity',      r'\b(?:liquidity|credit\s+(?:risk|facility|rating)|capital\s+(?:requirement|adequacy|structure))'),
    ('Operational',    r'\b(?:operational|supply\s+chain|manufactur|distribut|logistic|third.party)'),
    ('Legal',          r'\b(?:legal|lawsuit|litigation|arbitration|judgement|settlement|class\s+action)'),
    ('Geopolitical',   r'\b(?:geopolit|sanction|tariff|trade\s+(?:war|barrier|tension)|export\s+control)'),
    ('Technology',     r'\b(?:technolog|platform|system\s+(?:outage|failure)|infrastructure|software)'),
    ('Talent',         r'\b(?:key\s+personnel|workforce|talent|retention|employee|hire|attrition)'),
    ('Climate',        r'\b(?:climate|environmental|sustainability|carbon|ESG|greenhouse)'),
    ('AI & Data',      r'\b(?:artificial\s+intelligence|machine\s+learning|data\s+privacy|algorithm|\bAI\b)'),
    ('Concentration',  r'\b(?:concentrat|key\s+customer|single\s+customer|major\s+customer|depend\s+on)'),
    ('Market',         r'\b(?:market\s+(?:condition|volatil|fluctuat)|commodity|price\s+(?:change|pressure))'),
]


def _risk_cat(text):
    for name, pat in _RISK_CATS:
        if re.search(pat, text, re.IGNORECASE):
            return name
    return 'Other'


def _sec_extract_risk_cards(risk_text, limit=20):
    """Extract risk factor cards from the Risk Factors section.

    Pass A – short heading (3–14 words, starts capital, no long lowercase run)
             immediately followed by a body sentence  →  title + body card
    Pass B – ALL-CAPS heading block followed by body text
    Pass C – fallback: best standalone risk sentences containing risk keywords
    """
    if not risk_text:
        return []

    cards, seen = [], set()
    t = re.sub(r'\s{3,}', '  ', risk_text[:32000])

    # ── Pass A: short heading + body sentence pattern ─────────────────────
    raw = re.split(r'(?<=[.!?])\s+', t)
    i = 0
    while i < len(raw) - 1 and len(cards) < limit:
        head = raw[i].strip()
        body = raw[i + 1].strip()
        wc   = len(head.split())
        if (3 <= wc <= 14 and
                re.match(r'^[A-Z]', head) and
                not re.search(r'[a-z]{16,}', head) and
                len(body) > 80 and
                re.match(r'^[A-Z]', body)):
            title = head.rstrip('.!?,;')
            key   = title[:40]
            if key not in seen:
                seen.add(key)
                body_c = _sec_clean_sentence(body[:320])
                cards.append({
                    'title':       title,
                    'text':        body_c + ('…' if len(body) > 320 else ''),
                    'category':    _risk_cat(title + ' ' + body),
                    'section_key': 'risk_factors',
                })
            i += 2
        else:
            i += 1

    # ── Pass B: ALL-CAPS heading block ────────────────────────────────────
    if len(cards) < 5:
        cap_re = re.compile(
            r'([A-Z][A-Z\s,;&()\-—]{10,80}[A-Z])\s+([A-Z][^.!?]{50,}[.!?])'
        )
        for m in cap_re.finditer(t[:28000]):
            if len(cards) >= limit:
                break
            raw_title = m.group(1).strip()
            body      = m.group(2).strip()
            title     = raw_title.title()
            key = title[:40]
            if key in seen:
                continue
            seen.add(key)
            body_c = _sec_clean_sentence(body[:320])
            cards.append({
                'title':       title,
                'text':        body_c + ('…' if len(body) > 320 else ''),
                'category':    _risk_cat(title + ' ' + body),
                'section_key': 'risk_factors',
            })

    # ── Pass C: fallback – meaningful risk sentences ──────────────────────
    if len(cards) < 5:
        risk_kw = re.compile(
            r'\b(?:risk|adversely|negatively|harm|impair|disrupt|threaten|'
            r'uncertain|volatil|fail|loss|damage|breach|penalty|sanction)\b',
            re.IGNORECASE,
        )
        for s in _sec_sentences(risk_text[:20000], max_len=420):
            key = s[:45]
            if key in seen or len(cards) >= limit:
                continue
            if not risk_kw.search(s):
                continue
            seen.add(key)
            cards.append({
                'title':       '',
                'text':        s,
                'category':    _risk_cat(s),
                'section_key': 'risk_factors',
            })

    return cards


def _sec_keyword_freq(text, top_n=25):
    """Financial keyword frequency; returns [{word, count}] for the chart."""
    STOPWORDS = {
        'the','a','an','and','or','of','to','in','for','on','is','are','was',
        'were','has','have','had','with','at','by','from','as','be','will',
        'that','this','it','its','we','our','they','their','said','after',
        'before','about','more','but','not','also','than','over','up','down',
        'all','can','into','been','would','could','should','may','might',
        'which','who','how','when','what','company','stock','year','years',
        'share','shares','fiscal','three','four','five','six','during','each',
        'total','ended','per','related','including','such','these','those',
        'there','than','where','within','other','certain','based','used','made',
        'make','use','provide','following','through','between','under','upon',
        'whether','however','while','form','date','number','amount','value',
        'information','business','financial','results','operations','period',
        'approximately','respectively','accordance','consolidated',
    }
    freq = {}
    for w in re.findall(r'\b[a-z]{4,}\b', text.lower()[:32000]):
        if w not in STOPWORDS:
            freq[w] = freq.get(w, 0) + 1
    return [{'word': w, 'count': c}
            for w, c in sorted(freq.items(), key=lambda x: x[1], reverse=True)[:top_n]]


def _analyze_filing_local(ticker, company_name, filing_type,
                          filing_date, period_end, text):
    """Fully local, API-free EDGAR filing analysis.
    Returns keyword frequency, key financial figures, and filing tone."""
    figures  = _sec_extract_figures(text)
    sections = _sec_extract_sections(text)
    sent, score = _sec_compute_sentiment(sections.get('mda', '') or text)
    keywords = _sec_keyword_freq(text)

    return {
        'sentiment':       sent,
        'sentiment_score': score,
        'figures':         figures,
        'keywords':        keywords,
        'sections_found':  list(sections.keys()),
    }


# ── XBRL Aliases & Ratio Computation ──────────────────────────────────────

# Canonical key → ordered list of XBRL tag fallbacks (most common first)
XBRL_ALIASES = {
    # ── Income Statement ──────────────────────────────────────────────────
    "Revenue": [
        "RevenueFromContractWithCustomerExcludingAssessedTax",
        "RevenueFromContractWithCustomerIncludingAssessedTax",
        "Revenues", "SalesRevenueNet", "SalesRevenueGoodsNet",
        "SalesRevenueServicesNet", "RevenueNet",
    ],
    "COGS": [
        "CostOfGoodsAndServicesSold", "CostOfRevenue",
        "CostOfGoodsSold", "CostOfServices", "CostOfSales",
    ],
    "GrossProfit":     ["GrossProfit"],
    "RnD": [
        "ResearchAndDevelopmentExpense",
        "ResearchAndDevelopmentExpenseExcludingAcquiredInProcessCost",
    ],
    "SGA": [
        "SellingGeneralAndAdministrativeExpense",
        "GeneralAndAdministrativeExpense", "SellingAndMarketingExpense",
    ],
    "DA": [
        "DepreciationDepletionAndAmortization",
        "DepreciationAndAmortization", "Depreciation",
        "AmortizationOfIntangibleAssets",
    ],
    "OperatingIncome": [
        "OperatingIncomeLoss",
        "IncomeLossFromContinuingOperationsBeforeInterestExpenseInterestIncomeIncomeTaxesExtraordinaryItemsNoncontrollingInterestsNet",
    ],
    "InterestExpense": [
        "InterestExpense", "InterestAndDebtExpense",
        "InterestExpenseDebt", "InterestExpenseLongTermDebt",
    ],
    "InterestIncome": [
        "InvestmentIncomeInterest",
        "InterestAndDividendIncomeOperating", "InterestIncomeOperating",
    ],
    "IncomeTax":  ["IncomeTaxExpenseBenefit"],
    "IncomeBefore": [
        "IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest",
        "IncomeLossFromContinuingOperationsBeforeIncomeTaxesDomestic",
        "IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments",
    ],
    "NetIncome": [
        "NetIncomeLoss", "ProfitLoss",
        "NetIncomeLossAvailableToCommonStockholdersBasic",
        "NetIncomeLossAttributableToParent",
    ],
    "SBC": [
        "ShareBasedCompensation",
        "AllocatedShareBasedCompensationExpense",
        "EmployeeBenefitsAndShareBasedCompensation",
    ],
    "EPS_Basic":    ["EarningsPerShareBasic"],
    "EPS_Diluted":  ["EarningsPerShareDiluted"],
    "Shares_Basic": [
        "WeightedAverageNumberOfSharesOutstandingBasic",
        "CommonStockSharesOutstanding",
    ],
    # ── Balance Sheet ─────────────────────────────────────────────────────
    "Cash": [
        "CashAndCashEquivalentsAtCarryingValue",
        "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents",
        "CashAndDueFromBanks", "Cash",
    ],
    "STI": [
        "ShortTermInvestments",
        "AvailableForSaleSecuritiesCurrent",
        "MarketableSecuritiesCurrent",
    ],
    "Receivables": [
        "AccountsReceivableNetCurrent",
        "ReceivablesNetCurrent",
        "AccountsAndOtherReceivablesNetCurrent",
    ],
    "Inventory": [
        "InventoryNet", "Inventories",
        "InventoryFinishedGoods", "InventoryFinishedGoodsNetOfReserves",
    ],
    "OtherCurrentAssets": ["OtherAssetsCurrent", "PrepaidExpenseAndOtherAssets"],
    "CurrentAssets":      ["AssetsCurrent"],
    "PPE": [
        "PropertyPlantAndEquipmentNet",
        "PropertyPlantAndEquipmentAndFinanceLeaseRightOfUseAssetAfterAccumulatedDepreciationAndAmortization",
    ],
    "Goodwill":    ["Goodwill"],
    "Intangibles": ["IntangibleAssetsNetExcludingGoodwill", "FiniteLivedIntangibleAssetsNet"],
    "TotalAssets":         ["Assets"],
    "AccountsPayable":     ["AccountsPayableCurrent", "AccountsPayableAndAccruedLiabilitiesCurrent"],
    "ShortTermDebt":       ["ShortTermBorrowings", "LongTermDebtCurrent", "DebtCurrent"],
    "DeferredRevenue":     ["DeferredRevenueCurrent", "ContractWithCustomerLiabilityCurrent"],
    "CurrentLiabilities":  ["LiabilitiesCurrent"],
    "LongTermDebt":        ["LongTermDebtNoncurrent", "LongTermDebt", "LongTermNotesPayable"],
    "TotalLiabilities":    ["Liabilities"],
    "RetainedEarnings":    ["RetainedEarningsAccumulatedDeficit", "RetainedEarnings"],
    "TreasuryStock":       ["TreasuryStockValue", "TreasuryStockCommonValue"],
    "TotalEquity": [
        "StockholdersEquity",
        "StockholdersEquityAttributableToParent",
    ],
    # ── Cash Flow ─────────────────────────────────────────────────────────
    "OperatingCF": [
        "NetCashProvidedByUsedInOperatingActivities",
        "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations",
    ],
    "CapEx": [
        "PaymentsToAcquirePropertyPlantAndEquipment",
        "PaymentsForCapitalImprovements",
    ],
    "Acquisitions": [
        "PaymentsToAcquireBusinessesNetOfCashAcquired",
        "PaymentsToAcquireBusinessesAndInterestInAffiliates",
    ],
    "InvestingCF": [
        "NetCashProvidedByUsedInInvestingActivities",
        "NetCashProvidedByUsedInInvestingActivitiesContinuingOperations",
    ],
    "DebtRepayment": ["RepaymentsOfLongTermDebt", "RepaymentsOfDebt"],
    "Buybacks":      ["PaymentsForRepurchaseOfCommonStock", "PaymentsForRepurchaseOfEquity"],
    "Dividends":     ["PaymentsOfDividends", "PaymentsOfDividendsCommonStock"],
    "FinancingCF": [
        "NetCashProvidedByUsedInFinancingActivities",
        "NetCashProvidedByUsedInFinancingActivitiesContinuingOperations",
    ],
    "NetCashChange": [
        "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalentsPeriodIncreaseDecreaseIncludingExchangeRateEffect",
        "CashAndCashEquivalentsPeriodIncreaseDecrease",
    ],
}

def _resolve_tag_v2(facts, tag_key, flow=True):
    """
    Smart XBRL resolver with proper period handling.
    flow=True  (income/CF): prefer annual 340-380d; fall back to TTM from quarters.
    flow=False (balance sheet): most recent snapshot value.
    Returns (float_value, resolved_tag) or (None, None).
    """
    tags = XBRL_ALIASES.get(tag_key, [tag_key])
    for tag in tags:
        for taxonomy in facts.get("facts", {}).values():
            if not isinstance(taxonomy, dict) or tag not in taxonomy:
                continue
            entry = taxonomy[tag]
            for unit, records in entry.get("units", {}).items():
                if not records:
                    continue
                frame = pd.DataFrame(records)
                if "val" not in frame.columns or frame.empty:
                    continue
                frame["end"] = pd.to_datetime(frame["end"], errors="coerce")
                frame = frame.dropna(subset=["end"])
                if frame.empty:
                    continue
                if "filed" in frame.columns:
                    frame["filed"] = pd.to_datetime(frame["filed"], errors="coerce")
                    frame = (frame.sort_values("filed")
                                  .drop_duplicates("end", keep="last"))
                frame = frame.sort_values("end")
                if "start" in frame.columns:
                    frame["start"] = pd.to_datetime(frame["start"], errors="coerce")
                    frame["days"] = (frame["end"] - frame["start"]).dt.days.fillna(-1)
                    if flow:
                        # 1. Prefer full-year annual period
                        annual = frame[frame["days"].between(340, 380)]
                        if not annual.empty:
                            return float(annual["val"].iloc[-1]), tag
                        # 2. TTM: sum last 4 non-overlapping quarters
                        qtrs = frame[frame["days"].between(60, 105)]
                        if len(qtrs) >= 4:
                            return float(qtrs["val"].iloc[-4:].sum()), tag
                        if len(qtrs) >= 2:
                            n = len(qtrs)
                            return float(qtrs["val"].sum() / n * 4), tag
                    else:
                        # Balance sheet with a start date — just use most recent
                        if not frame.empty:
                            return float(frame["val"].iloc[-1]), tag
                else:
                    # No start → instantaneous (typical balance sheet item)
                    if not frame.empty:
                        return float(frame["val"].iloc[-1]), tag
    return None, None


def _G(facts, key, flow=True):
    val, _ = _resolve_tag_v2(facts, key, flow=flow)
    return val


def compute_ratios(facts):
    """
    Compute financial ratios.
    Dynamically resolves the best-matching XBRL tag for each company
    (e.g. NetIncomeLoss vs ProfitLoss) and records which tag was used.
    Returns five focused categories:
      Earnings | Profitability | Debt Management | Return on Assets | Return to Shareholders
    """
    # _g2: resolves tag and returns (value, tag_name_used)
    def _g2(key, flow=True):
        return _resolve_tag_v2(facts, key, flow=flow)

    def _div(num, den, mult=1):
        if num is None or den is None or den == 0:
            return None
        return (num / den) * mult

    def _r(name, category, desc, fmt, val, source=""):
        health = _ratio_health(name, val, fmt) if val is not None else "neutral"
        status = "ok" if val is not None else "missing_data"
        return dict(name=name, category=category, value=val, fmt=fmt,
                    description=desc, status=status, health=health,
                    source=source or "")

    # ── Resolve all inputs — record tag actually used ─────────────────────
    revenue,      rev_tag  = _g2("Revenue",         flow=True)
    gross_profit, gp_tag   = _g2("GrossProfit",      flow=True)
    op_income,    oi_tag   = _g2("OperatingIncome",  flow=True)
    net_income,   ni_tag   = _g2("NetIncome",        flow=True)
    interest_exp, ie_tag   = _g2("InterestExpense",  flow=True)
    da,           da_tag   = _g2("DA",               flow=True)
    op_cf,        ocf_tag  = _g2("OperatingCF",      flow=True)
    capex_raw,    cx_tag   = _g2("CapEx",            flow=True)
    eps_diluted,  eps_tag  = _g2("EPS_Diluted",      flow=True)
    dividends,    div_tag  = _g2("Dividends",        flow=True)
    buybacks,     bb_tag   = _g2("Buybacks",         flow=True)

    cash,         _ca_tag  = _g2("Cash",               flow=False)
    cur_liab,     cl_tag   = _g2("CurrentLiabilities", flow=False)
    total_assets, ta_tag   = _g2("TotalAssets",        flow=False)
    lt_debt,      ltd_tag  = _g2("LongTermDebt",       flow=False)
    st_debt,      std_tag  = _g2("ShortTermDebt",      flow=False)
    total_liab,   tl_tag   = _g2("TotalLiabilities",   flow=False)
    equity,       eq_tag   = _g2("TotalEquity",        flow=False)

    # ── Derived values ────────────────────────────────────────────────────
    cash      = cash     or 0.0
    lt_debt   = lt_debt  or 0.0
    st_debt   = st_debt  or 0.0
    total_debt = lt_debt + st_debt
    ebitda    = ((op_income or 0) + (da or 0)) if op_income is not None else None
    capex     = abs(capex_raw) if capex_raw is not None else None
    fcf       = ((op_cf or 0) - (capex or 0)) if op_cf is not None and capex is not None else None
    net_debt  = total_debt - cash
    div_abs   = abs(dividends) if dividends is not None else None
    bb_abs    = abs(buybacks)  if buybacks  is not None else None
    cap_return = ((div_abs or 0) + (bb_abs or 0)) \
                 if (div_abs is not None or bb_abs is not None) else None
    # Invested capital = Total Assets − Current Liabilities
    inv_cap   = (total_assets - (cur_liab or 0)) \
                if total_assets is not None and cur_liab is not None else None

    return [
        # ── Earnings ─────────────────────────────────────────────────────────
        _r("Revenue",              "Earnings",
           "Total revenue / net sales (TTM or annual)",
           "$", revenue,       rev_tag or "—"),
        _r("Gross Profit",         "Earnings",
           "Revenue minus cost of revenue",
           "$", gross_profit,  gp_tag  or "—"),
        _r("Operating Income",     "Earnings",
           "Earnings before interest & tax (EBIT)",
           "$", op_income,     oi_tag  or "—"),
        _r("Net Income",           "Earnings",
           "Bottom-line profit attributable to shareholders",
           "$", net_income,    ni_tag  or "—"),
        _r("EBITDA",               "Earnings",
           "Operating Income + Depreciation & Amortization",
           "$", ebitda,        f"{oi_tag or '—'}+{da_tag or '—'}"),
        _r("Free Cash Flow",       "Earnings",
           "Operating Cash Flow minus Capital Expenditures",
           "$", fcf,           f"{ocf_tag or '—'}−{cx_tag or '—'}"),
        _r("EPS (Diluted)",        "Earnings",
           "Diluted earnings per share",
           "eps", eps_diluted, eps_tag or "—"),

        # ── Profitability ─────────────────────────────────────────────────────
        _r("Gross Margin",         "Profitability",
           "Gross Profit ÷ Revenue",
           "%", _div(gross_profit, revenue, 100),
           f"{gp_tag or '—'} ÷ {rev_tag or '—'}"),
        _r("Operating Margin",     "Profitability",
           "Operating Income ÷ Revenue",
           "%", _div(op_income, revenue, 100),
           f"{oi_tag or '—'} ÷ {rev_tag or '—'}"),
        _r("Net Profit Margin",    "Profitability",
           "Net Income ÷ Revenue",
           "%", _div(net_income, revenue, 100),
           f"{ni_tag or '—'} ÷ {rev_tag or '—'}"),
        _r("EBITDA Margin",        "Profitability",
           "EBITDA ÷ Revenue",
           "%", _div(ebitda, revenue, 100),
           f"EBITDA ÷ {rev_tag or '—'}"),
        _r("FCF Margin",           "Profitability",
           "Free Cash Flow ÷ Revenue",
           "%", _div(fcf, revenue, 100),
           f"FCF ÷ {rev_tag or '—'}"),
        _r("OCF Margin",           "Profitability",
           "Operating Cash Flow ÷ Revenue",
           "%", _div(op_cf, revenue, 100),
           f"{ocf_tag or '—'} ÷ {rev_tag or '—'}"),

        # ── Debt Management ───────────────────────────────────────────────────
        _r("Debt / Equity",        "Debt Management",
           "Total Debt (ST + LT) ÷ Shareholders' Equity",
           "x", _div(total_debt, equity),
           f"Debt ÷ {eq_tag or '—'}"),
        _r("Debt / Assets",        "Debt Management",
           "Total Liabilities ÷ Total Assets",
           "x", _div(total_liab, total_assets),
           f"{tl_tag or '—'} ÷ {ta_tag or '—'}"),
        _r("Interest Coverage",    "Debt Management",
           "Operating Income ÷ Interest Expense  (higher = safer)",
           "x", _div(op_income, interest_exp),
           f"{oi_tag or '—'} ÷ {ie_tag or '—'}"),
        _r("Net Debt / EBITDA",    "Debt Management",
           "(Total Debt − Cash) ÷ EBITDA",
           "x", _div(net_debt, ebitda) if ebitda else None,
           "NetDebt ÷ EBITDA"),
        _r("Net Debt",             "Debt Management",
           "Total Debt minus Cash & Equivalents",
           "$", net_debt if (total_debt or cash) else None,
           f"TotalDebt − {_ca_tag or '—'}"),

        # ── Return on Assets ──────────────────────────────────────────────────
        _r("Return on Assets",     "Return on Assets",
           "Net Income ÷ Total Assets",
           "%", _div(net_income, total_assets, 100),
           f"{ni_tag or '—'} ÷ {ta_tag or '—'}"),
        _r("Return on Inv. Capital","Return on Assets",
           "Operating Income ÷ (Assets − Current Liabilities)",
           "%", _div(op_income, inv_cap, 100) if inv_cap else None,
           f"{oi_tag or '—'} ÷ InvestedCapital"),
        _r("Op. Return on Assets", "Return on Assets",
           "Operating Income ÷ Total Assets",
           "%", _div(op_income, total_assets, 100),
           f"{oi_tag or '—'} ÷ {ta_tag or '—'}"),

        # ── Return to Shareholders ────────────────────────────────────────────
        _r("Return on Equity",     "Return to Shareholders",
           "Net Income ÷ Shareholders' Equity",
           "%", _div(net_income, equity, 100),
           f"{ni_tag or '—'} ÷ {eq_tag or '—'}"),
        _r("Dividends Paid",       "Return to Shareholders",
           "Cash dividends paid to shareholders (TTM)",
           "$", div_abs,           div_tag or "—"),
        _r("Share Buybacks",       "Return to Shareholders",
           "Common stock repurchased (TTM)",
           "$", bb_abs,            bb_tag  or "—"),
        _r("Total Capital Return", "Return to Shareholders",
           "Dividends + Buybacks returned to shareholders",
           "$", cap_return,        f"{div_tag or '—'} + {bb_tag or '—'}"),
        _r("Div / FCF",            "Return to Shareholders",
           "Dividends Paid ÷ Free Cash Flow  (sustainability check)",
           "%", _div(div_abs, fcf, 100) if (fcf and fcf > 0) else None,
           f"{div_tag or '—'} ÷ FCF"),
    ]


def _fmt_ratio(value, fmt):
    if value is None: return "—"
    if fmt == "x":   return f"{value:.2f}x"
    if fmt == "%":   return f"{value:.1f}%"
    if fmt == "$":   return _fmt_large(value)
    if fmt == "eps": return f"${value:.2f}"
    if fmt == "days":return f"{value:.1f} days"
    return f"{value:.2f}"


def _fmt_large(x):
    if abs(x) >= 1e12: return f"{x / 1e12:.2f}T"
    if abs(x) >= 1e9: return f"{x / 1e9:.2f}B"
    if abs(x) >= 1e6: return f"{x / 1e6:.2f}M"
    if abs(x) >= 1e3: return f"{x / 1e3:.2f}K"
    return f"{x:,.2f}"


def _ratio_health(name, value, fmt):
    if value is None: return "neutral"
    n = name.lower()
    # ── Earnings (absolute $ — just flag negative) ────────────────────────
    if fmt == "$":
        if n in ("revenue", "gross profit", "free cash flow", "ebitda"):
            return "good" if value > 0 else "bad"
        if "net income" in n:    return "good" if value > 0 else "bad"
        if "net debt"   in n:    return "good" if value < 0 else "ok" if value < 5e9 else "bad"
        if "dividends"  in n:    return "good" if value > 0 else "neutral"
        if "buyback"    in n or "repurchas" in n: return "good" if value > 0 else "neutral"
        if "capital return" in n: return "good" if value > 0 else "neutral"
        return "neutral"
    # ── EPS ──────────────────────────────────────────────────────────────
    if fmt == "eps":             return "good" if value > 2 else "ok" if value > 0 else "bad"
    # ── Profitability margins ─────────────────────────────────────────────
    if "gross margin"      in n: return "good" if value > 50  else "ok" if value > 25  else "bad"
    if "operating margin"  in n: return "good" if value > 20  else "ok" if value > 10  else "bad"
    if "net profit margin" in n: return "good" if value > 20  else "ok" if value > 8   else "bad"
    if "ebitda margin"     in n: return "good" if value > 30  else "ok" if value > 15  else "bad"
    if "fcf margin"        in n: return "good" if value > 15  else "ok" if value > 5   else "bad"
    if "ocf margin"        in n: return "good" if value > 20  else "ok" if value > 10  else "bad"
    # ── Debt Management ───────────────────────────────────────────────────
    if "debt / equity"     in n: return "good" if value < 1   else "ok" if value < 2.5 else "bad"
    if "debt / assets"     in n: return "good" if value < 0.4 else "ok" if value < 0.65 else "bad"
    if "interest coverage" in n: return "good" if value > 5   else "ok" if value > 2   else "bad"
    if "net debt / ebitda" in n: return "good" if value < 1.5 else "ok" if value < 3   else "bad"
    # ── Return on Assets ──────────────────────────────────────────────────
    if "return on assets"  in n: return "good" if value > 10  else "ok" if value > 5   else "bad"
    if "return on inv"     in n: return "good" if value > 12  else "ok" if value > 6   else "bad"
    if "op. return"        in n: return "good" if value > 10  else "ok" if value > 5   else "bad"
    # ── Return to Shareholders ────────────────────────────────────────────
    if "return on equity"  in n: return "good" if value > 15  else "ok" if value > 8   else "bad"
    if "div / fcf"         in n: return "good" if value < 60  else "ok" if value < 90  else "bad"
    return "neutral"


# ── Financial Statement Schemas ────────────────────────────────────────────
# (display_label, xbrl_alias_key, is_flow, row_type)
# row_type: None | 'subtotal' | 'highlight' | 'derived' | 'dim' | 'per_share' | 'shares'

IS_SCHEMA = [
    ("Revenue",               "Revenue",         True,  "highlight"),
    ("Cost of Revenue",       "COGS",            True,  None),
    ("Gross Profit",          "GrossProfit",      True,  "subtotal"),
    ("R&D Expenses",          "RnD",             True,  None),
    ("SG&A Expenses",         "SGA",             True,  None),
    ("Depreciation & Amort.", "DA",              True,  "dim"),
    ("Operating Income",      "OperatingIncome", True,  "subtotal"),
    ("Interest Expense",      "InterestExpense", True,  None),
    ("Interest Income",       "InterestIncome",  True,  None),
    ("Income Before Tax",     "IncomeBefore",    True,  "dim"),
    ("Income Tax",            "IncomeTax",       True,  None),
    ("Net Income",            "NetIncome",       True,  "highlight"),
    ("EPS (Diluted)",         "EPS_Diluted",     True,  "per_share"),
    ("Shares (Basic, M)",     "Shares_Basic",    True,  "shares"),
    ("Stock-Based Comp.",     "SBC",             True,  "dim"),
]

BS_SCHEMA = [
    ("Cash & Equivalents",    "Cash",            False, "highlight"),
    ("Short-term Invest.",     "STI",             False, None),
    ("Accounts Receivable",   "Receivables",     False, None),
    ("Inventory",             "Inventory",       False, None),
    ("Other Current Assets",  "OtherCurrentAssets", False, None),
    ("Total Current Assets",  "CurrentAssets",   False, "subtotal"),
    ("PP&E, Net",             "PPE",             False, None),
    ("Goodwill",              "Goodwill",        False, None),
    ("Intangible Assets",     "Intangibles",     False, None),
    ("Total Assets",          "TotalAssets",     False, "highlight"),
    ("Accounts Payable",      "AccountsPayable", False, None),
    ("Short-term Debt",       "ShortTermDebt",   False, None),
    ("Deferred Revenue",      "DeferredRevenue", False, None),
    ("Total Current Liab.",   "CurrentLiabilities", False, "subtotal"),
    ("Long-term Debt",        "LongTermDebt",    False, None),
    ("Total Liabilities",     "TotalLiabilities",False, "highlight"),
    ("Retained Earnings",     "RetainedEarnings",False, None),
    ("Treasury Stock",        "TreasuryStock",   False, None),
    ("Total Equity",          "TotalEquity",     False, "highlight"),
]

CF_SCHEMA = [
    ("Net Income",            "NetIncome",       True,  "dim"),
    ("Depreciation & Amort.", "DA",              True,  None),
    ("Stock-Based Comp.",     "SBC",             True,  None),
    ("Operating Cash Flow",   "OperatingCF",     True,  "highlight"),
    ("Capital Expenditures",  "CapEx",           True,  None),
    ("Acquisitions",          "Acquisitions",    True,  None),
    ("Investing Cash Flow",   "InvestingCF",     True,  "highlight"),
    ("Debt Repayment",        "DebtRepayment",   True,  None),
    ("Stock Buybacks",        "Buybacks",        True,  None),
    ("Dividends Paid",        "Dividends",       True,  None),
    ("Financing Cash Flow",   "FinancingCF",     True,  "highlight"),
    ("Free Cash Flow *",      "__derived_fcf",   True,  "derived"),
    ("Net Change in Cash",    "NetCashChange",   True,  "subtotal"),
]


def _tag_timeseries(facts, tags, period_type='annual', n=8):
    """
    Find the best time series for a list of XBRL tag names.
    period_type: 'annual' | 'quarterly' | 'snapshot' | 'snapshot_qtr'
    Returns (labels, values, tag_used) or (None, None, None).
    """
    pr_map = {'annual': (340, 380), 'quarterly': (60, 105)}
    for tag in tags:
        for taxonomy in facts.get("facts", {}).values():
            if not isinstance(taxonomy, dict) or tag not in taxonomy:
                continue
            entry = taxonomy[tag]
            for unit, records in entry.get("units", {}).items():
                if not records:
                    continue
                frame = pd.DataFrame(records)
                if "val" not in frame.columns or frame.empty:
                    continue
                frame["end"] = pd.to_datetime(frame["end"], errors="coerce")
                frame = frame.dropna(subset=["end"])
                if frame.empty:
                    continue
                if "filed" in frame.columns:
                    frame["filed"] = pd.to_datetime(frame["filed"], errors="coerce")
                    frame = (frame.sort_values("filed")
                                  .drop_duplicates("end", keep="last"))

                if period_type in pr_map:
                    if "start" not in frame.columns:
                        continue
                    frame["start"] = pd.to_datetime(frame["start"], errors="coerce")
                    frame["days"] = (frame["end"] - frame["start"]).dt.days
                    lo, hi = pr_map[period_type]
                    frame = frame[frame["days"].between(lo, hi)]
                    if frame.empty:
                        continue
                    frame = frame.sort_values("end")
                    lbl_fn = ((lambda e: f"FY{e.year}") if period_type == 'annual'
                              else (lambda e: f"Q{(e.month-1)//3+1} {e.year}"))
                elif period_type == 'snapshot':
                    frame = frame.sort_values("end")
                    frame["_yr"] = frame["end"].dt.year
                    frame = frame.drop_duplicates("_yr", keep="last")
                    lbl_fn = lambda e: f"FY{e.year}"
                elif period_type == 'snapshot_qtr':
                    frame = frame.sort_values("end")
                    frame["_qk"] = frame["end"].apply(
                        lambda e: (e.year, (e.month - 1) // 3 + 1))
                    frame = frame.drop_duplicates("_qk", keep="last")
                    lbl_fn = lambda e: f"Q{(e.month-1)//3+1} {e.year}"
                else:
                    continue

                frame = frame.sort_values("end")
                if frame.empty:
                    continue
                lbls = frame["end"].apply(lbl_fn).tolist()
                vals = frame["val"].astype(float).tolist()
                # Deduplicate labels (keep last)
                seen, out = set(), []
                for lbl, v in reversed(list(zip(lbls, vals))):
                    if lbl not in seen:
                        seen.add(lbl)
                        out.append((lbl, v))
                out.reverse()
                out = out[-n:]
                if out:
                    return [p[0] for p in out], [p[1] for p in out], tag
    return None, None, None


def _build_statement(facts, schema, period_type='annual', n_periods=8):
    """Build an aligned financial statement from XBRL facts."""
    row_data     = []
    label_counts = {}

    for (label, tag_key, flow, row_type) in schema:
        if row_type == 'derived':
            row_data.append({'label': label, 'type': row_type, 'vals': {}, 'tag': None})
            continue
        tags = XBRL_ALIASES.get(tag_key, [tag_key]) if isinstance(tag_key, str) else tag_key
        if period_type == 'annual':
            pt = 'annual'   if flow else 'snapshot'
        else:
            pt = 'quarterly' if flow else 'snapshot_qtr'
        lbls, vals, tag_used = _tag_timeseries(facts, tags, pt, n_periods * 2)
        if lbls and vals:
            series = dict(zip(lbls, vals))
            row_data.append({'label': label, 'type': row_type,
                             'vals': series, 'tag': tag_used})
            for lbl in lbls:
                label_counts[lbl] = label_counts.get(lbl, 0) + 1
        else:
            row_data.append({'label': label, 'type': row_type, 'vals': {}, 'tag': None})

    if not label_counts:
        return {'periods': [], 'rows': [], 'scale': {'unit': '', 'divisor': 1}}

    def _sk(lbl):
        try:
            if lbl.startswith('FY'): return (int(lbl[2:]), 0, 0)
            if lbl.startswith('Q'):
                p = lbl.split(); return (int(p[1]), 1, int(p[0][1]))
        except Exception:
            pass
        return (0, 0, 0)

    n_with = sum(1 for r in row_data if r['vals'])
    min_cnt = max(1, n_with // 5)
    cands   = [l for l, c in label_counts.items() if c >= min_cnt] or list(label_counts)
    periods = sorted(cands, key=_sk)[-n_periods:]

    # Auto-scale (ignore EPS/shares rows)
    all_abs = []
    for r in row_data:
        if r['type'] not in ('derived', 'per_share', 'shares'):
            for lbl in periods:
                v = r['vals'].get(lbl)
                if v is not None:
                    all_abs.append(abs(v))
    divisor, unit_str = 1, ''
    if all_abs:
        mx = max(all_abs)
        if mx >= 5e10:   divisor, unit_str = 1e9, 'B'
        elif mx >= 5e7:  divisor, unit_str = 1e6, 'M'
        elif mx >= 5e4:  divisor, unit_str = 1e3, 'K'

    rows_out = []
    for r in row_data:
        if r['type'] == 'derived':
            ocf_r = next((x for x in row_data if 'Operating Cash Flow' in x['label']), None)
            cap_r = next((x for x in row_data if 'Capital Expenditures' in x['label']), None)
            vout  = []
            for lbl in periods:
                ov = ocf_r['vals'].get(lbl) if ocf_r else None
                cv = cap_r['vals'].get(lbl) if cap_r else None
                if ov is not None and cv is not None:
                    fcf = ov + cv if cv < 0 else ov - cv
                    vout.append(round(fcf / divisor, 3))
                else:
                    vout.append(None)
            rows_out.append({'label': r['label'], 'tag': 'derived',
                             'values': vout, 'type': r['type']})
        elif r['type'] in ('per_share', 'shares'):
            vout = [round(r['vals'][l], 4) if l in r['vals'] else None for l in periods]
            rows_out.append({'label': r['label'], 'tag': r['tag'],
                             'values': vout, 'type': r['type']})
        else:
            vout = [
                round(r['vals'][l] / divisor, 3)
                if l in r['vals'] and r['vals'][l] is not None else None
                for l in periods
            ]
            rows_out.append({'label': r['label'], 'tag': r['tag'],
                             'values': vout, 'type': r['type']})

    return {'periods': periods, 'rows': rows_out,
            'scale': {'divisor': divisor, 'unit': unit_str}}


# ── FRED ───────────────────────────────────────────────────────────────────

FRED_CATALOGUE = {
    "GDP & Growth": {
        "GDP":      ("Gross Domestic Product",              "Billions $", "#2563EB"),
        "GDPC1":    ("Real GDP (Inflation-Adjusted)",       "Billions $", "#059669"),
        "GDPPOT":   ("Potential GDP",                       "Billions $", "#4DA6FF"),
        "GDPDEF":   ("GDP Price Deflator",                  "Index",      "#D97706"),
        "A939RC0Q052SBEA": ("Federal Spending % of GDP",   "%",          "#DC2626"),
        "GPDIC1":   ("Real Gross Private Investment",       "Billions $", "#7C3AED"),
        "PCEC96":   ("Real Personal Consumption",           "Billions $", "#FF7B54"),
        "NETEXP":   ("Net Exports of Goods & Services",     "Billions $", "#B06EFF"),
    },
    "Inflation": {
        "CPIAUCSL": ("CPI — All Items",                     "Index",      "#D97706"),
        "CPILFESL": ("CPI — Core (ex. Food & Energy)",      "Index",      "#EA580C"),
        "PCEPI":    ("PCE Price Index",                     "Index",      "#7C3AED"),
        "PCEPILFE": ("PCE Core (ex. Food & Energy)",        "Index",      "#B06EFF"),
        "CPIENGSL": ("CPI — Energy",                        "Index",      "#DC2626"),
        "CPIFABSL": ("CPI — Food & Beverages",              "Index",      "#FFB347"),
        "WPSFD4131":("PPI — Final Demand",                  "Index",      "#FF7B54"),
        "T5YIE":    ("5-Year Inflation Expectations",       "%",          "#059669"),
        "T10YIE":   ("10-Year Inflation Expectations",      "%",          "#4DA6FF"),
        "MICH":     ("Michigan Inflation Expectations",     "%",          "#2563EB"),
    },
    "Interest Rates": {
        "FEDFUNDS":  ("Federal Funds Rate",                 "%",          "#DC2626"),
        "DFF":       ("Effective Fed Funds Rate (Daily)",   "%",          "#FF3D6B"),
        "DGS1MO":    ("1-Month Treasury Yield",             "%",          "#B06EFF"),
        "DGS3MO":    ("3-Month Treasury Yield",             "%",          "#7C3AED"),
        "DGS6MO":    ("6-Month Treasury Yield",             "%",          "#EA580C"),
        "DGS1":      ("1-Year Treasury Yield",              "%",          "#D97706"),
        "DGS2":      ("2-Year Treasury Yield",              "%",          "#FFB347"),
        "DGS5":      ("5-Year Treasury Yield",              "%",          "#FF7B54"),
        "DGS10":     ("10-Year Treasury Yield",             "%",          "#4DA6FF"),
        "DGS20":     ("20-Year Treasury Yield",             "%",          "#059669"),
        "DGS30":     ("30-Year Treasury Yield",             "%",          "#2563EB"),
        "T10Y2Y":    ("10Y – 2Y Yield Spread",              "%",          "#DC2626"),
        "T10Y3M":    ("10Y – 3M Yield Spread",              "%",          "#FF3D6B"),
    },
    "Labor Market": {
        "UNRATE":   ("Unemployment Rate",                   "%",          "#DC2626"),
        "U6RATE":   ("U-6 Underemployment Rate",            "%",          "#FF3D6B"),
        "PAYEMS":   ("Nonfarm Payrolls",                    "Thousands",  "#16A34A"),
        "MANEMP":   ("Manufacturing Employment",            "Thousands",  "#2563EB"),
        "CIVPART":  ("Labor Force Participation Rate",      "%",          "#D97706"),
        "EMRATIO":  ("Employment-Population Ratio",         "%",          "#059669"),
        "ICSA":     ("Initial Jobless Claims",              "Thousands",  "#DC2626"),
        "CCSA":     ("Continuing Jobless Claims",           "Thousands",  "#FF7B54"),
        "JOLTSJOL": ("JOLTS: Job Openings",                 "Thousands",  "#4DA6FF"),
        "JOLTSQUR": ("JOLTS: Quits Rate",                   "%",          "#7C3AED"),
        "LES1252881600Q": ("Median Weekly Earnings",        "$",          "#FFB347"),
    },
    "Housing Market": {
        "MORTGAGE30US": ("30-Year Mortgage Rate",           "%",          "#DC2626"),
        "MORTGAGE15US": ("15-Year Mortgage Rate",           "%",          "#FF7B54"),
        "HOUST":    ("Housing Starts",                      "Thousands",  "#2563EB"),
        "PERMIT":   ("Building Permits",                    "Thousands",  "#4DA6FF"),
        "MSPUS":    ("Median Sales Price of Homes",         "$",          "#D97706"),
        "CSUSHPISA":("Case-Shiller Home Price Index",       "Index",      "#FFB347"),
        "EXHOSLUSM495S": ("Existing Home Sales",            "Millions",   "#059669"),
        "HSN1F":    ("New Single-Family Home Sales",        "Thousands",  "#7C3AED"),
        "NHSUSSPT": ("Months Supply of Homes",              "Months",     "#B06EFF"),
        "RHORUSQ156N": ("US Homeownership Rate",            "%",          "#FF3D6B"),
    },
    "Consumer & Income": {
        "PCE":      ("Personal Consumption Expenditures",   "Billions $", "#D97706"),
        "DSPIC96":  ("Real Disposable Personal Income",     "Billions $", "#059669"),
        "PSAVERT":  ("Personal Saving Rate",                "%",          "#4DA6FF"),
        "UMCSENT":  ("Michigan Consumer Sentiment",         "Index",      "#2563EB"),
        "RSXFS":    ("Advance Retail Sales",                "Millions $", "#FF7B54"),
        "TOTALSL":  ("Total Consumer Credit",               "Billions $", "#DC2626"),
        "REVOLSL":  ("Revolving Consumer Credit",           "Billions $", "#7C3AED"),
    },
    "Money & Banking": {
        "M2SL":     ("Money Supply M2",                     "Billions $", "#7C3AED"),
        "BOGMBASE": ("Monetary Base",                       "Billions $", "#B06EFF"),
        "WALCL":    ("Fed Balance Sheet — Total Assets",    "Millions $", "#DC2626"),
        "TOTRESNS": ("Total Reserves of Depository Inst.",  "Billions $", "#FF7B54"),
        "BUSLOANS": ("Commercial & Industrial Loans",       "Billions $", "#2563EB"),
        "MPRIME":   ("Bank Prime Loan Rate",                "%",          "#D97706"),
        "DPSACBW027SBOG": ("Deposits at Commercial Banks",  "Billions $", "#059669"),
    },
    "Markets & Risk": {
        "VIXCLS":   ("VIX Volatility Index",                "Index",      "#DC2626"),
        "BAMLH0A0HYM2": ("High Yield OAS Spread",          "%",          "#FF3D6B"),
        "BAMLC0A0CM":   ("Invest. Grade OAS Spread",       "%",          "#FF7B54"),
        "TEDRATE":  ("TED Spread",                          "%",          "#D97706"),
        "DCOILWTICO": ("WTI Crude Oil Price",               "$/bbl",      "#059669"),
        "MCOILBRENTEU": ("Brent Crude Oil Price",           "$/bbl",      "#4DA6FF"),
        "GOLDAMGBD228NLBM": ("Gold Price (AM Fix)",         "$/oz",       "#FFB347"),
        "DHHNGSP":  ("Natural Gas Price",                   "$/MMBtu",    "#B06EFF"),
        "PPIACO":   ("PPI — All Commodities",               "Index",      "#7C3AED"),
    },
    "Trade & International": {
        "BOPGSTB":  ("Trade Balance — Goods & Services",   "Billions $", "#DC2626"),
        "EXPGS":    ("Exports of Goods & Services",         "Billions $", "#059669"),
        "IMPGS":    ("Imports of Goods & Services",         "Billions $", "#FF3D6B"),
        "DTWEXBGS": ("Trade Weighted USD — Broad",          "Index",      "#2563EB"),
        "DTWEXM":   ("Trade Weighted USD — Major Curr.",    "Index",      "#4DA6FF"),
        "EXCHUS":   ("US / China Exchange Rate",            "Yuan/USD",   "#D97706"),
        "EXUSEU":   ("US / Euro Exchange Rate",             "USD/EUR",    "#7C3AED"),
    },
    "Government & Fiscal": {
        "FYFSD":    ("Federal Budget Surplus / Deficit",    "Millions $", "#DC2626"),
        "GFDEBTN":  ("Federal Debt — Total",                "Millions $", "#FF3D6B"),
        "GFDEGDQ188S": ("Federal Debt as % of GDP",        "%",          "#D97706"),
        "W006RC1Q027SBEA": ("Federal Gov. Expenditures",   "Billions $", "#7C3AED"),
        "A955RC1Q027SBEA": ("State & Local Expenditures",  "Billions $", "#B06EFF"),
    },
}

# Flat lookup: series_id → {label, units, color, category}
FRED_FLAT = {}
for _cat, _series in FRED_CATALOGUE.items():
    for _sid, (_lbl, _units, _col) in _series.items():
        FRED_FLAT[_sid] = {"label": _lbl, "units": _units, "color": _col, "category": _cat}

# Key macro series shown in the dashboard overview (6 tiles)
FRED_DASHBOARD_SERIES = [
    ("GDP",      "Real GDP",              "Billions $", "#2563EB"),
    ("CPIAUCSL", "CPI — All Items",       "Index",      "#D97706"),
    ("FEDFUNDS", "Fed Funds Rate",        "%",          "#DC2626"),
    ("UNRATE",   "Unemployment Rate",     "%",          "#7C3AED"),
    ("DGS10",    "10Y Treasury Yield",    "%",          "#059669"),
    ("VIXCLS",   "VIX Volatility",        "Index",      "#FF7B54"),
]


def fred_fetch(series_id, observation_start="1990-01-01"):
    params = {
        "series_id": series_id.upper(),
        "api_key": FRED_API_KEY,
        "file_type": "json",
        "sort_order": "asc",
        "observation_start": observation_start,
    }
    r = _FRED_SESSION.get("https://api.stlouisfed.org/fred/series/observations",
                          params=params, timeout=15)
    r.raise_for_status()
    obs = r.json().get("observations", [])
    rows = []
    for o in obs:
        try:
            rows.append({"date": o["date"], "value": float(o["value"])})
        except (ValueError, KeyError):
            pass
    return rows


# ═══════════════════════════════════════════════════════════════════════════════
#  COMPOSITE SIGNAL ENGINE (preserved from original)
# ═══════════════════════════════════════════════════════════════════════════════

def _clip(v, lo=-1.0, hi=1.0):
    return max(lo, min(hi, float(v))) if v is not None else 0.0

def _normalise_rsi(rsi):
    if rsi is None: return 0.0
    if rsi > 70: return _clip(-(rsi - 70) / 30)
    if rsi < 30: return _clip((30 - rsi) / 30)
    return _clip((50 - rsi) / 40)

def _normalise_stoch(k):
    if k is None: return 0.0
    if k > 80: return _clip(-(k - 80) / 20)
    if k < 20: return _clip((20 - k) / 20)
    return _clip((50 - k) / 60)

def _sma_cross_signal(df):
    if df.empty: return 0.0
    last = df.iloc[-1]
    s50, s200 = last.get("SMA_50"), last.get("SMA_200")
    if s50 is None or s200 is None or s200 == 0: return 0.0
    return _clip((s50 - s200) / s200 / 0.05)

def _ema_price_signal(df):
    if df.empty: return 0.0
    last = df.iloc[-1]
    price, ema = last.get("Close"), last.get("EMA_20")
    if price is None or ema is None or ema == 0: return 0.0
    return _clip((price - ema) / ema / 0.05)

def _macd_signal(df):
    if df.empty: return 0.0
    last = df.iloc[-1]
    macd, signal = last.get("MACD"), last.get("MACD_signal")
    if macd is None or signal is None: return 0.0
    cross = 1.0 if macd > signal else -1.0
    zero = 1.0 if macd > 0 else -1.0
    hist_trend = 0.0
    if len(df) >= 3 and "MACD_hist" in df.columns:
        h = df["MACD_hist"].dropna()
        if len(h) >= 3:
            hist_trend = 1.0 if h.iloc[-1] > h.iloc[-3] else -1.0
    return _clip(cross * 0.5 + zero * 0.3 + hist_trend * 0.2)

def _bb_signal(df):
    if df.empty: return 0.0
    last = df.iloc[-1]
    price, upper, lower, mid = last.get("Close"), last.get("BB_upper"), last.get("BB_lower"), last.get("BB_mid")
    if None in (price, upper, lower, mid) or (upper - lower) == 0: return 0.0
    pos = (price - mid) / ((upper - lower) / 2)
    return -_clip(pos)

def _volume_trend_signal(df):
    if df.empty or "OBV" not in df.columns or len(df) < 40: return 0.0
    obv = df["OBV"].dropna(); price = df["Close"].dropna()
    if len(obv) < 40: return 0.0
    obv_up = obv.iloc[-20:].mean() > obv.iloc[-40:-20].mean()
    price_up = price.iloc[-20:].mean() > price.iloc[-40:-20].mean()
    if obv_up and price_up: return +0.8
    if not obv_up and not price_up: return -0.8
    if obv_up and not price_up: return +0.5
    return -0.5

def _atr_risk_signal(df):
    if df.empty or "ATR" not in df.columns: return 0.0
    last = df.iloc[-1]
    atr, price = last.get("ATR"), last.get("Close")
    if atr is None or price is None or price == 0: return 0.0
    return _clip(1.0 - atr / price / 0.03)

def _max_drawdown_signal(df):
    if df.empty or "Close" not in df.columns: return 0.0
    close = df["Close"].dropna()
    if len(close) < 10: return 0.0
    dd = (close / close.cummax() - 1).iloc[-1]
    return _clip(-dd / 0.5 * 0.5)

def _sharpe_signal(df):
    if df.empty or "Return" not in df.columns: return 0.0
    ret = df["Return"].dropna()
    if len(ret) < 20 or ret.std() == 0: return 0.0
    sharpe = (ret.mean() / ret.std()) * math.sqrt(252)
    return _clip(sharpe / 3.0)

def _price_trend_signal(df, window=60):
    if df.empty or len(df) < window: return 0.0
    close = df["Close"].dropna().tail(window).values
    x = np.arange(len(close), dtype=float)
    slope = np.polyfit(x, close, 1)[0]
    mean = close.mean()
    if mean == 0: return 0.0
    return _clip(slope / mean / 0.005)

def _stochastic_momentum_signal(df):
    if df.empty: return 0.0
    last = df.iloc[-1]
    k, d = last.get("Stoch_K"), last.get("Stoch_D")
    if k is None or d is None: return 0.0
    zone = _normalise_stoch(k)
    cross = 1.0 if k > d else -1.0
    return _clip(zone * 0.6 + cross * 0.4)

def _ratio_to_signal(value, good_thresh, bad_thresh, higher_is_better=True):
    if value is None: return 0.0
    if higher_is_better:
        if value >= good_thresh: return +1.0
        if value <= bad_thresh: return -1.0
        return _clip((value - bad_thresh) / (good_thresh - bad_thresh) * 2 - 1)
    else:
        if value <= good_thresh: return +1.0
        if value >= bad_thresh: return -1.0
        return _clip((bad_thresh - value) / (bad_thresh - good_thresh) * 2 - 1)

def _fundamental_score(facts):
    if not facts: return 0.0, {}
    ratios = {r["name"]: r for r in compute_ratios(facts)}
    def val(name):
        r = ratios.get(name)
        return r["value"] if r and r["status"] == "ok" else None
    signals = {}
    # Weights sum to ~1.0
    signals["de_ratio"]     = _ratio_to_signal(val("Debt / Equity"),      0.5,  3.0,  False) * 0.15
    signals["int_coverage"] = _ratio_to_signal(val("Interest Coverage"),   5.0,  1.5,  True)  * 0.10
    signals["gross_margin"] = _ratio_to_signal(val("Gross Margin"),       50.0, 10.0,  True)  * 0.15
    signals["op_margin"]    = _ratio_to_signal(val("Operating Margin"),   20.0,  0.0,  True)  * 0.15
    signals["net_margin"]   = _ratio_to_signal(val("Net Profit Margin"),  15.0,  0.0,  True)  * 0.15
    signals["roe"]          = _ratio_to_signal(val("Return on Equity"),   15.0,  0.0,  True)  * 0.10
    signals["roa"]          = _ratio_to_signal(val("Return on Assets"),    8.0,  0.0,  True)  * 0.10
    signals["fcf_margin"]   = _ratio_to_signal(val("FCF Margin"),         15.0,  0.0,  True)  * 0.10
    total = sum(signals.values())
    return _clip(total / 1.00), signals

def _sentiment_score(news_df):
    if news_df is None or news_df.empty: return 0.0, {}
    df = news_df.copy()
    if "score" not in df.columns or "published" not in df.columns: return 0.0, {}
    df = df.dropna(subset=["score", "published"])
    if df.empty: return 0.0, {}
    n = len(df)
    df = df.sort_values("published")
    weights = np.linspace(1.0, 3.0, len(df))
    weighted_mean = np.average(df["score"].values, weights=weights)
    pos_frac = (df["score"] > 0).sum() / n
    neg_frac = (df["score"] < 0).sum() / n
    conviction = 0.0
    if pos_frac > 0.70: conviction = +0.20
    elif neg_frac > 0.70: conviction = -0.20
    trend = 0.0
    if len(df) >= 6:
        recent = df["score"].iloc[-int(n * 0.3):].mean()
        older = df["score"].iloc[:int(n * 0.3)].mean()
        trend = _clip((recent - older) * 2)
    raw = _clip(weighted_mean + conviction * 0.5 + trend * 0.3)
    bd = {"articles": n, "weighted_mean": round(weighted_mean, 3),
          "pos_pct": round(pos_frac * 100, 1), "neg_pct": round(neg_frac * 100, 1),
          "trend": round(trend, 3)}
    return raw, bd

def run_signal_engine(ticker, tech_df, facts, news_df):
    df = tech_df if isinstance(tech_df, pd.DataFrame) and not tech_df.empty else pd.DataFrame()
    tech_signals = {}
    tech_signals["rsi"] = _normalise_rsi(df.iloc[-1].get("RSI") if not df.empty else None) * 0.14
    tech_signals["macd"] = _macd_signal(df) * 0.16
    tech_signals["bb"] = _bb_signal(df) * 0.12
    tech_signals["sma_cross"] = _sma_cross_signal(df) * 0.14
    tech_signals["ema_price"] = _ema_price_signal(df) * 0.10
    tech_signals["stoch"] = _stochastic_momentum_signal(df) * 0.12
    tech_signals["price_trend"] = _price_trend_signal(df) * 0.12
    tech_signals["vol_trend"] = _volume_trend_signal(df) * 0.10
    tech_score = _clip(sum(tech_signals.values()))
    risk_signals = {}
    risk_signals["atr"] = _atr_risk_signal(df) * 0.35
    risk_signals["drawdown"] = _max_drawdown_signal(df) * 0.35
    risk_signals["sharpe"] = _sharpe_signal(df) * 0.30
    risk_score = _clip(sum(risk_signals.values()))
    fund_score, fund_signals = _fundamental_score(facts)
    sent_score, sent_breakdown = _sentiment_score(news_df)
    WEIGHTS = {"tech": 0.40, "fund": 0.30, "sent": 0.20, "risk": 0.10}
    data_present = {"tech": not df.empty, "fund": bool(facts),
                    "sent": (news_df is not None and not news_df.empty), "risk": not df.empty}
    active_weight = sum(w for k, w in WEIGHTS.items() if data_present[k])
    if active_weight == 0:
        master_score = 0.0
    else:
        raw = sum(
            (tech_score if k == "tech" else fund_score if k == "fund"
             else sent_score if k == "sent" else risk_score) * w * data_present[k]
            for k, w in WEIGHTS.items()
        ) / active_weight
        master_score = _clip(raw)
    confidence = min(100, int(sum(1 for v in {**tech_signals, **risk_signals, **fund_signals}.values() if v != 0) / 20 * 100))
    if master_score >= 0.15: signal = "BUY"
    elif master_score <= -0.15: signal = "SELL"
    else: signal = "HOLD"
    return {
        "signal": signal, "master_score": round(master_score, 4),
        "confidence": confidence,
        "tech_score": round(tech_score, 4), "fund_score": round(fund_score, 4),
        "sent_score": round(sent_score, 4), "risk_score": round(risk_score, 4),
        "tech_signals": {k: round(v, 4) for k, v in tech_signals.items()},
        "fund_signals": {k: round(v, 4) for k, v in fund_signals.items()},
        "sent_breakdown": sent_breakdown,
        "risk_signals": {k: round(v, 4) for k, v in risk_signals.items()},
        "data_present": data_present,
    }


# ═══════════════════════════════════════════════════════════════════════════════
#  BACKTESTING ENGINE
# ═══════════════════════════════════════════════════════════════════════════════

def _compute_signal_series(df: pd.DataFrame) -> pd.Series:
    """Vectorized per-row technical signal for backtesting (no fundamental/sentiment)."""
    scores = pd.Series(0.0, index=df.index)
    # RSI
    if "RSI" in df.columns:
        scores += df["RSI"].apply(_normalise_rsi).fillna(0) * 0.18
    # MACD
    if "MACD" in df.columns and "MACD_signal" in df.columns:
        direction = np.where(df["MACD"] > df["MACD_signal"], 1.0, -1.0)
        hist_norm = df["MACD_hist"].fillna(0).abs().clip(upper=1.0)
        scores += pd.Series(direction * hist_norm.values, index=df.index) * 0.20
    # Bollinger Bands (mean reversion: near lower = bullish)
    if "BB_upper" in df.columns and "BB_lower" in df.columns:
        spread = (df["BB_upper"] - df["BB_lower"]).replace(0, np.nan)
        bb_pos = (df["Close"] - df["BB_lower"]) / spread
        bb_sig = (1 - 2 * bb_pos).clip(-1, 1)
        scores += bb_sig.fillna(0) * 0.14
    # SMA cross (SMA_50 vs SMA_200)
    if "SMA_50" in df.columns and "SMA_200" in df.columns:
        spread = df["SMA_200"].replace(0, np.nan)
        sma_sig = ((df["SMA_50"] - df["SMA_200"]) / spread / 0.05).clip(-1, 1)
        scores += sma_sig.fillna(0) * 0.16
    # EMA vs price
    if "EMA_20" in df.columns:
        ema_sig = np.where(df["Close"] > df["EMA_20"], 1.0, -1.0)
        scores += pd.Series(ema_sig, index=df.index).fillna(0) * 0.12
    # Stochastic
    if "Stoch_K" in df.columns:
        stoch_sig = df["Stoch_K"].apply(_normalise_stoch).fillna(0)
        scores += stoch_sig * 0.12
    # Price trend (20-day momentum)
    price_trend = df["Close"].pct_change(20).clip(-0.5, 0.5) * 2
    scores += price_trend.fillna(0) * 0.08
    return scores.clip(-1, 1)


def _compute_sma_crossover_signal(df: pd.DataFrame) -> pd.Series:
    """SMA 50/200 golden-cross / death-cross only. +1 when 50 > 200, -1 otherwise."""
    if "SMA_50" not in df.columns or "SMA_200" not in df.columns:
        return pd.Series(0.0, index=df.index)
    spread = df["SMA_200"].replace(0, np.nan)
    # Normalise by how far apart the SMAs are (capped at ±1)
    sig = ((df["SMA_50"] - df["SMA_200"]) / spread / 0.05).clip(-1, 1)
    return sig.fillna(0)


def _compute_momentum_signal(df: pd.DataFrame) -> pd.Series:
    """Pure momentum strategy: RSI + rate-of-change at multiple horizons + Stochastic."""
    scores = pd.Series(0.0, index=df.index)
    # RSI (40% weight)
    if "RSI" in df.columns:
        scores += df["RSI"].apply(_normalise_rsi).fillna(0) * 0.40
    # 20-day ROC (30% weight)
    roc20 = df["Close"].pct_change(20).clip(-0.5, 0.5) * 2
    scores += roc20.fillna(0) * 0.30
    # Stochastic %K (30% weight)
    if "Stoch_K" in df.columns:
        scores += df["Stoch_K"].apply(_normalise_stoch).fillna(0) * 0.30
    return scores.clip(-1, 1)


# ── Macro Composite Strategy helpers ───────────────────────────────────────

def _fetch_fred_series_for_macro(series_id: str) -> pd.Series:
    """Fetch a single FRED series and return as a tz-naive date-indexed Series.
    Results are cached in _MACRO_CACHE for the server session."""
    global _MACRO_CACHE
    if series_id in _MACRO_CACHE:
        return _MACRO_CACHE[series_id]
    try:
        params = {
            "series_id": series_id,
            "api_key": FRED_API_KEY,
            "file_type": "json",
            "observation_start": "1985-01-01",
            "limit": 10000,
        }
        r = _SESSION.get(
            "https://api.stlouisfed.org/fred/series/observations",
            params=params, timeout=10
        )
        obs = r.json().get("observations", [])
        data = {}
        for o in obs:
            try:
                val = float(o["value"])
                data[pd.Timestamp(o["date"])] = val
            except (ValueError, TypeError):
                pass
        s = pd.Series(data, dtype=float).sort_index()
        _MACRO_CACHE[series_id] = s
        return s
    except Exception:
        return pd.Series(dtype=float)


def _compute_pnf_signal_series(df: pd.DataFrame,
                                box_pct: float = 0.01,
                                reversal: int = 3) -> pd.Series:
    """
    Synthetic Point & Figure reversal signal — vectorised over the Close series.

    At each date the signal is:
      +1 (scaled) if price is building an X-column (upward boxes)
      -1 (scaled) if price is building an O-column (downward boxes)
    Magnitude grows with column depth and is capped at ±1.0.
    """
    prices = df["Close"].values.astype(float)
    n = len(prices)
    signals = np.zeros(n, dtype=float)

    if n < 20:
        return pd.Series(signals, index=df.index)

    col_dir = 1       # +1 = X column, -1 = O column
    last_lvl = prices[0]
    col_boxes = 1

    for i in range(n):
        p = prices[i]
        box_sz = max(last_lvl * box_pct, 1e-10)

        if col_dir == 1:                            # currently in X column
            up_boxes = int((p - last_lvl) / box_sz)
            if up_boxes > 0:
                col_boxes += up_boxes
                last_lvl += up_boxes * box_sz
            elif (last_lvl - p) >= reversal * box_sz:   # reversal → start O
                col_dir = -1
                last_lvl -= reversal * box_sz
                col_boxes = reversal
        else:                                       # currently in O column
            dn_boxes = int((last_lvl - p) / box_sz)
            if dn_boxes > 0:
                col_boxes += dn_boxes
                last_lvl -= dn_boxes * box_sz
            elif (p - last_lvl) >= reversal * box_sz:   # reversal → start X
                col_dir = 1
                last_lvl += reversal * box_sz
                col_boxes = reversal

        # Signal: direction × capped depth score
        signals[i] = col_dir * min(1.0, 0.30 + col_boxes * 0.07)

    return pd.Series(signals, index=df.index).clip(-1, 1)


def _compute_macro_signal_series(df: pd.DataFrame) -> pd.Series:
    """
    FRED-based macroeconomic signal aligned to df.index (daily).

    Components
    ----------
    T10Y2Y  (35%)  : Yield-curve spread — positive = normal = bullish;
                     negative = inverted = bearish recession signal.
    VIXCLS  (35%)  : VIX fear gauge — low VIX = calm markets = bullish;
                     high VIX = fear = bearish.
    UNRATE  (30%)  : Unemployment rate 6-month momentum — falling = bullish;
                     rising = bearish.
    """
    base = pd.Series(0.0, index=df.index)

    # ── Yield Curve (T10Y2Y) ────────────────────────────────────────────────
    yc = _fetch_fred_series_for_macro("T10Y2Y")
    if not yc.empty:
        yc_aln = yc.reindex(df.index, method='ffill').fillna(0)
        # Typical range: −3 to +3 percentage points; /2 normalises to ≈−1…+1
        base += (yc_aln / 2.0).clip(-1, 1) * 0.35

    # ── VIX (VIXCLS) ────────────────────────────────────────────────────────
    vix = _fetch_fred_series_for_macro("VIXCLS")
    if not vix.empty:
        vix_aln = vix.reindex(df.index, method='ffill').fillna(20)
        # VIX 10 → +1 (calm); VIX 25 → 0 (neutral); VIX 40 → −1 (fear)
        base += ((25.0 - vix_aln) / 15.0).clip(-1, 1) * 0.35

    # ── Unemployment Rate (UNRATE) ──────────────────────────────────────────
    ur = _fetch_fred_series_for_macro("UNRATE")
    if not ur.empty:
        ur_aln = ur.reindex(df.index, method='ffill')
        # 6-month rate of change (~126 trading days); falling UR = bullish
        ur_roc = ur_aln.pct_change(126).fillna(0)
        base += (-ur_roc * 5).clip(-1, 1) * 0.30

    return base.clip(-1, 1)


def _compute_macro_composite_signal(df: pd.DataFrame) -> pd.Series:
    """
    Multi-source strategy:
      70% Combined technical (8-indicator composite)
      10% Point & Figure reversal pattern
      20% Macroeconomic overlay (yield curve + VIX + unemployment)
    """
    tech  = _compute_signal_series(df)        # 0.70
    pnf   = _compute_pnf_signal_series(df)    # 0.10
    macro = _compute_macro_signal_series(df)  # 0.20
    return (tech * 0.70 + pnf * 0.10 + macro * 0.20).clip(-1, 1)


def run_backtest(ticker: str, start_date: str, end_date: str,
                 initial_capital: float, buy_thresh: float, sell_thresh: float,
                 lookback_days: int, strategy: str = 'combined') -> dict:
    start_dt = datetime.strptime(start_date, '%Y-%m-%d')
    end_dt = datetime.strptime(end_date, '%Y-%m-%d')

    raw = fetch_ohlc(ticker, days=0)
    df = compute_indicators(raw)

    if strategy == 'sma_crossover':
        signal_series = _compute_sma_crossover_signal(df)
    elif strategy == 'momentum':
        signal_series = _compute_momentum_signal(df)
    elif strategy == 'macro_composite':
        signal_series = _compute_macro_composite_signal(df)
    else:  # 'combined'
        signal_series = _compute_signal_series(df)

    # Slice to backtest window
    mask = (df.index >= pd.Timestamp(start_dt)) & (df.index <= pd.Timestamp(end_dt))
    df_bt = df[mask]
    sig_bt = signal_series[mask]

    if df_bt.empty:
        raise ValueError("No data in specified date range.")

    prices = df_bt["Close"]
    dates = df_bt.index

    # Simulate long-only strategy
    capital = initial_capital
    position = None  # None=flat, dict when holding
    equity_curve = []
    trades = []

    for date, price, sig in zip(dates, prices, sig_bt):
        if position is None:
            if sig >= buy_thresh:
                shares = capital / price
                position = {'entry_price': price, 'entry_date': date, 'shares': shares}
                trades.append({'date': date.strftime('%Y-%m-%d'), 'action': 'BUY',
                               'price': round(float(price), 2), 'signal': round(float(sig), 4)})
        else:
            if sig <= sell_thresh:
                capital = position['shares'] * price
                pnl = capital - position['shares'] * position['entry_price']
                trades.append({'date': date.strftime('%Y-%m-%d'), 'action': 'SELL',
                               'price': round(float(price), 2), 'signal': round(float(sig), 4),
                               'pnl': round(float(pnl), 2)})
                position = None

        current_equity = position['shares'] * price if position else capital
        equity_curve.append({
            'date': date.strftime('%Y-%m-%d'),
            'equity': round(float(current_equity), 2),
            'signal': round(float(sig), 4)
        })

    # Close open position at end
    if position is not None:
        final_price = float(prices.iloc[-1])
        capital = position['shares'] * final_price
        trades.append({'date': dates[-1].strftime('%Y-%m-%d'), 'action': 'SELL(end)',
                       'price': round(final_price, 2), 'signal': round(float(sig_bt.iloc[-1]), 4),
                       'pnl': round(capital - position['shares'] * position['entry_price'], 2)})

    # Benchmark (buy & hold)
    p0, pN = float(prices.iloc[0]), float(prices.iloc[-1])
    bh_shares = initial_capital / p0
    benchmark = [{'date': d.strftime('%Y-%m-%d'), 'equity': round(float(bh_shares * p), 2)}
                 for d, p in zip(dates, prices)]

    # Stats
    total_return = round((capital / initial_capital - 1) * 100, 2)
    bench_return = round((pN / p0 - 1) * 100, 2)

    # Annualized returns
    _bt_years = max((end_dt - start_dt).days / 365.25, 0.01)
    annualized_return = round(((capital / initial_capital) ** (1 / _bt_years) - 1) * 100, 2)
    bench_annualized  = round(((pN / p0) ** (1 / _bt_years) - 1) * 100, 2)
    eq_vals = [e['equity'] for e in equity_curve]
    peak, max_dd = initial_capital, 0.0
    for v in eq_vals:
        if v > peak: peak = v
        dd = (peak - v) / peak if peak > 0 else 0
        if dd > max_dd: max_dd = dd

    sell_trades = [t for t in trades if 'SELL' in t['action']]
    win_trades = [t for t in sell_trades if t.get('pnl', 0) > 0]
    win_rate = round(len(win_trades) / len(sell_trades) * 100, 1) if sell_trades else 0.0

    daily_rets = [(eq_vals[i] - eq_vals[i - 1]) / eq_vals[i - 1]
                  for i in range(1, len(eq_vals)) if eq_vals[i - 1] > 0]
    if len(daily_rets) > 1:
        mu = sum(daily_rets) / len(daily_rets)
        std = (sum((r - mu) ** 2 for r in daily_rets) / len(daily_rets)) ** 0.5
        sharpe = round(mu / std * (252 ** 0.5) if std > 0 else 0.0, 2)
    else:
        sharpe = 0.0

    return {
        'equity_curve': equity_curve,
        'benchmark': benchmark,
        'trades': trades[-100:],
        'stats': {
            'total_return': total_return,
            'annualized_return': annualized_return,
            'benchmark_return': bench_return,
            'bench_annualized': bench_annualized,
            'alpha': round(total_return - bench_return, 2),
            'annualized_alpha': round(annualized_return - bench_annualized, 2),
            'backtest_years': round(_bt_years, 1),
            'max_drawdown': round(max_dd * 100, 2),
            'win_rate': win_rate,
            'num_trades': len(sell_trades),
            'sharpe': sharpe,
            'initial_capital': initial_capital,
            'final_equity': round(capital, 2),
        }
    }


# ═══════════════════════════════════════════════════════════════════════════════
#  ROUTES — AUTH
# ═══════════════════════════════════════════════════════════════════════════════

@app.route('/')
def index():
    if current_user.is_authenticated:
        return redirect(url_for('dashboard'))
    return redirect(url_for('login'))


@app.route('/health')
def health():
    """Health check endpoint — useful for verifying DB connectivity on Railway."""
    try:
        db.session.execute(db.text('SELECT 1'))
        db_ok = True
        db_msg = app.config['SQLALCHEMY_DATABASE_URI'].split('@')[-1] if '@' in app.config['SQLALCHEMY_DATABASE_URI'] else 'sqlite'
    except Exception as exc:
        db_ok = False
        db_msg = str(exc)
    status = 200 if db_ok else 500
    return jsonify({'status': 'ok' if db_ok else 'error', 'db': db_msg}), status


@app.route('/register', methods=['GET', 'POST'])
def register():
    if current_user.is_authenticated:
        return redirect(url_for('dashboard'))
    form = RegistrationForm()
    if form.validate_on_submit():
        try:
            user = User(username=form.username.data, email=form.email.data)
            user.set_password(form.password.data)
            db.session.add(user)
            db.session.commit()
            flash('Account created! You can now sign in.', 'success')
            return redirect(url_for('login'))
        except Exception as exc:
            db.session.rollback()
            app.logger.error(f'Register error: {exc}')
            flash('Could not create account — please try again.', 'danger')
    return render_template('register.html', form=form)




@app.route('/login', methods=['GET', 'POST'])
def login():
    if current_user.is_authenticated:
        return redirect(url_for('dashboard'))
    form = LoginForm()
    if form.validate_on_submit():
        user = User.query.filter_by(email=form.email.data).first()
        if user and user.check_password(form.password.data):
            user.last_login = datetime.utcnow()
            db.session.commit()
            login_user(user, remember=form.remember.data)
            next_page = request.args.get('next', '') or url_for('dashboard')
            return redirect(next_page)
        flash('Invalid email or password.', 'danger')
    return render_template('login.html', form=form)


@app.route('/logout')
@login_required
def logout():
    logout_user()
    flash('Signed out.', 'info')
    return redirect(url_for('login'))


@app.route('/profile', methods=['GET', 'POST'])
@login_required
def profile():
    form = ProfileForm(obj=current_user)
    pw_form = ChangePasswordForm()
    if form.validate_on_submit() and 'update_profile' in request.form:
        if form.username.data != current_user.username:
            existing = User.query.filter_by(username=form.username.data).first()
            if existing:
                flash('Username already taken.', 'danger')
                return render_template('profile.html', form=form, pw_form=pw_form)
        if form.email.data != current_user.email:
            existing = User.query.filter_by(email=form.email.data).first()
            if existing:
                flash('Email already registered.', 'danger')
                return render_template('profile.html', form=form, pw_form=pw_form)
        current_user.username = form.username.data
        current_user.email = form.email.data
        current_user.first_name = form.first_name.data
        current_user.last_name = form.last_name.data
        current_user.bio = form.bio.data
        current_user.watchlist = form.watchlist.data
        db.session.commit()
        flash('Profile updated.', 'success')
        return redirect(url_for('profile'))
    return render_template('profile.html', form=form, pw_form=pw_form)


@app.route('/change-password', methods=['POST'])
@login_required
def change_password():
    pw_form = ChangePasswordForm()
    if pw_form.validate_on_submit():
        if not current_user.check_password(pw_form.current_password.data):
            flash('Current password is incorrect.', 'danger')
        else:
            current_user.set_password(pw_form.new_password.data)
            db.session.commit()
            flash('Password changed.', 'success')
    else:
        for field, errors in pw_form.errors.items():
            for error in errors:
                flash(f'{error}', 'danger')
    return redirect(url_for('profile'))


@app.route('/delete-account', methods=['POST'])
@login_required
def delete_account():
    SearchHistory.query.filter_by(user_id=current_user.id).delete()
    db.session.delete(current_user)
    db.session.commit()
    logout_user()
    flash('Account deleted.', 'info')
    return redirect(url_for('login'))


# ═══════════════════════════════════════════════════════════════════════════════
#  ROUTES — MAIN PAGES
# ═══════════════════════════════════════════════════════════════════════════════

@app.route('/dashboard')
@login_required
def dashboard():
    history = SearchHistory.query.filter_by(user_id=current_user.id)\
        .order_by(SearchHistory.searched_at.desc()).limit(10).all()
    return render_template('dashboard.html', history=history, fred_catalogue=FRED_CATALOGUE)


@app.route('/technical')
@login_required
def technical():
    return render_template('module.html', module='technical')


@app.route('/fundamentals')
@login_required
def fundamentals():
    return render_template('module.html', module='fundamentals')


@app.route('/correlation')
@login_required
def correlation():
    return render_template('module.html', module='correlation')


@app.route('/economic')
@login_required
def economic():
    return render_template('module.html', module='economic', fred_catalogue=FRED_CATALOGUE, fred_flat=FRED_FLAT)


@app.route('/news')
@login_required
def news():
    return render_template('module.html', module='news')


@app.route('/signal')
@login_required
def signal_page():
    return render_template('module.html', module='signal')


# ═══════════════════════════════════════════════════════════════════════════════
#  API ROUTES
# ═══════════════════════════════════════════════════════════════════════════════

def _log_search(ticker, module):
    if current_user.is_authenticated:
        sh = SearchHistory(user_id=current_user.id, ticker=ticker.upper(), module=module)
        db.session.add(sh)
        db.session.commit()


@app.route('/api/technical/<ticker>')
@login_required
def api_technical(ticker):
    period   = request.args.get('period', '1Y')
    interval = request.args.get('interval', '1d').lower().strip()
    if interval in ('', 'daily'): interval = '1d'
    is_intraday = interval != '1d'

    today    = datetime.today()
    ytd_days = (today - datetime(today.year, 1, 1)).days + 1

    # yfinance period strings for intraday requests
    _INTRADAY_PERIOD_MAP = {
        '1D':'1d',  '3D':'5d',  '5D':'5d',  '7D':'7d',
        '1W':'5d',  '1M':'1mo', '2M':'2mo',
        '3M':'3mo', '6M':'6mo', '1Y':'1y',
    }

    try:
        if is_intraday:
            period_str = _INTRADAY_PERIOD_MAP.get(period, '5d')
            raw = fetch_ohlc_intraday(ticker, interval, period_str)
            df  = compute_indicators(raw)
            _log_search(ticker, 'technical')
            df_clean = df.copy()
            # Full datetime string so Plotly renders correct intraday axis
            df_clean.index = df_clean.index.strftime('%Y-%m-%d %H:%M')
        else:
            days_map = {
                "3M": 92, "6M": 183, "YTD": ytd_days,
                "1Y": 365, "3Y": 1095, "5Y": 1825,
                "10Y": 3650, "MAX": 0, "CUSTOM": 0,
            }
            days = days_map.get(period, 365)
            raw = fetch_ohlc(ticker, days=days)
            df  = compute_indicators(raw)
            _log_search(ticker, 'technical')
            df_clean = df.copy()
            df_clean.index = df_clean.index.strftime('%Y-%m-%d')

        data  = df_clean.replace([np.inf, -np.inf], None).where(pd.notnull(df_clean), None)
        ret   = df["Return"].dropna()
        close = df["Close"]
        n     = len(close)

        stats = {
            "latest_close":     round(close.iloc[-1], 2),
            "prev_close":       round(close.iloc[-2], 2) if n > 1 else round(close.iloc[-1], 2),
            "change":           round(close.iloc[-1] - close.iloc[-2], 2) if n > 1 else 0,
            "change_pct":       round((close.iloc[-1] - close.iloc[-2]) / close.iloc[-2] * 100, 2) if n > 1 else 0,
            "high_52w":         round(close.rolling(min(252, n)).max().iloc[-1], 2),
            "low_52w":          round(close.rolling(min(252, n)).min().iloc[-1], 2),
            "volatility":       round(ret.std() * np.sqrt(252) * 100, 2) if len(ret) > 0 else 0,
            "sharpe":           round((ret.mean() / ret.std()) * np.sqrt(252), 3) if len(ret) > 20 and ret.std() > 0 else 0,
            "max_drawdown":     round(((close / close.cummax()) - 1).min() * 100, 2),
            "rsi":              round(df['RSI'].iloc[-1], 1) if pd.notna(df['RSI'].iloc[-1]) else None,
            "atr":              round(df['ATR'].iloc[-1], 2) if pd.notna(df['ATR'].iloc[-1]) else None,
            "bb_width":         round(df['BB_width'].iloc[-1] * 100, 2) if pd.notna(df['BB_width'].iloc[-1]) else None,
            "stoch_k":          round(df['Stoch_K'].iloc[-1], 1) if pd.notna(df['Stoch_K'].iloc[-1]) else None,
            "macd_signal":      "Bullish" if df["MACD"].iloc[-1] > df["MACD_signal"].iloc[-1] else "Bearish",
            "all_time_high":    round(close.max(), 2),
            "all_time_low":     round(close.min(), 2),
            "years_of_history": round(n / 252, 1),
            "data_source":      f"yfinance · interval={interval}",
            "interval":         interval,
            "is_intraday":      is_intraday,
            "bar_count":        n,
        }

        return jsonify({
            "ticker":      ticker.upper(),
            "interval":    interval,
            "is_intraday": is_intraday,
            "dates":       list(data.index),
            "close":       data["Close"].tolist(),
            "open":        data["Open"].tolist(),
            "high":        data["High"].tolist(),
            "low":         data["Low"].tolist(),
            "volume":      data["Volume"].tolist(),
            "sma_20":      data["SMA_20"].tolist(),
            "sma_50":      data["SMA_50"].tolist(),
            "sma_200":     data["SMA_200"].tolist(),
            "ema_20":      data["EMA_20"].tolist(),
            "ema_9":       data["EMA_9"].tolist(),
            "vwap":        data["VWAP"].tolist(),
            "rsi":         data["RSI"].tolist(),
            "macd":        data["MACD"].tolist(),
            "macd_signal": data["MACD_signal"].tolist(),
            "macd_hist":   data["MACD_hist"].tolist(),
            "bb_upper":    data["BB_upper"].tolist(),
            "bb_lower":    data["BB_lower"].tolist(),
            "bb_mid":      data["BB_mid"].tolist(),
            "stoch_k":     data["Stoch_K"].tolist(),
            "stoch_d":     data["Stoch_D"].tolist(),
            "atr":         data["ATR"].tolist(),
            "obv":         (data["OBV"] / 1e6).tolist(),
            "returns":     (data["Return"] * 100).tolist(),
            "stats":       stats,
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 400


@app.route('/api/technical/<ticker>/moredata')
@login_required
def api_technical_moredata(ticker):
    """Return comprehensive yfinance data for the 'More Data' dashboard tab."""
    def _clean_val(v):
        if isinstance(v, float) and (v != v or v == float('inf') or v == float('-inf')):
            return None
        return v

    def _clean_info(raw: dict) -> dict:
        out = {}
        for k, v in raw.items():
            if isinstance(v, (str, int, bool, type(None))):
                out[k] = v
            elif isinstance(v, float):
                out[k] = _clean_val(v)
            # Skip lists/dicts (e.g. companyOfficers) — too large
        return out

    def _df_to_table(df) -> dict:
        """Serialise a yfinance DataFrame (items × periods) to a compact dict."""
        if df is None or not isinstance(df, pd.DataFrame) or df.empty:
            return {"dates": [], "rows": []}
        dc = df.copy()
        dates = [str(c)[:10] for c in dc.columns]
        rows = []
        for idx, row in dc.iterrows():
            vals = []
            for v in row.values:
                try:
                    f = float(v)
                    vals.append(_clean_val(f))
                except (TypeError, ValueError):
                    vals.append(None)
            rows.append({"item": str(idx), "values": vals})
        return {"dates": dates, "rows": rows}

    def _df_to_records(df) -> list:
        """Serialise a yfinance DataFrame to list of dicts."""
        if df is None or not isinstance(df, pd.DataFrame) or df.empty:
            return []
        dc = df.copy()
        if dc.index.name or (hasattr(dc.index, 'names') and any(dc.index.names)):
            dc = dc.reset_index()
        dc.columns = [str(c) for c in dc.columns]
        records = []
        for _, row in dc.iterrows():
            rec = {}
            for col, val in row.items():
                if isinstance(val, (pd.Timestamp,)):
                    rec[col] = str(val)[:10]
                elif isinstance(val, float):
                    rec[col] = _clean_val(val)
                else:
                    try:
                        rec[col] = str(val) if val is not None and str(val) not in ('nan', 'NaT') else None
                    except Exception:
                        rec[col] = None
            records.append(rec)
        return records

    try:
        sym = ticker.upper()
        tk = yf.Ticker(sym)

        # ── Company Info ──────────────────────────────────────────────────
        try:
            info = _clean_info(tk.info or {})
        except Exception:
            info = {}

        # ── Financial Statements ──────────────────────────────────────────
        try: financials     = _df_to_table(tk.financials)
        except Exception:   financials     = {"dates": [], "rows": []}
        try: q_financials   = _df_to_table(tk.quarterly_financials)
        except Exception:   q_financials   = {"dates": [], "rows": []}
        try: balance_sheet  = _df_to_table(tk.balance_sheet)
        except Exception:   balance_sheet  = {"dates": [], "rows": []}
        try: q_balance      = _df_to_table(tk.quarterly_balance_sheet)
        except Exception:   q_balance      = {"dates": [], "rows": []}
        try: cashflow       = _df_to_table(tk.cashflow)
        except Exception:   cashflow       = {"dates": [], "rows": []}
        try: q_cashflow     = _df_to_table(tk.quarterly_cashflow)
        except Exception:   q_cashflow     = {"dates": [], "rows": []}

        # ── Analyst & Holders ─────────────────────────────────────────────
        try: recommendations    = _df_to_records(tk.recommendations)
        except Exception:       recommendations = []
        try: upgrades           = _df_to_records(tk.upgrades_downgrades)[:20]
        except Exception:       upgrades = []
        try: inst_holders       = _df_to_records(tk.institutional_holders)
        except Exception:       inst_holders = []
        try: major_holders      = _df_to_records(tk.major_holders)
        except Exception:       major_holders = []
        try: mutual_fund        = _df_to_records(tk.mutualfund_holders)
        except Exception:       mutual_fund = []

        # ── Earnings / Calendar ───────────────────────────────────────────
        try: earnings_hist      = _df_to_records(tk.earnings_history)
        except Exception:       earnings_hist = []
        try:
            cal_raw = tk.calendar
            if isinstance(cal_raw, pd.DataFrame) and not cal_raw.empty:
                cal_raw.index = [str(i) for i in cal_raw.index]
                # pandas >= 2.1 renamed applymap → map; use try/except for compat
                try:
                    calendar = cal_raw.map(lambda x: str(x) if not isinstance(x,(int,float,type(None))) else x).to_dict()
                except AttributeError:
                    calendar = cal_raw.applymap(lambda x: str(x) if not isinstance(x,(int,float,type(None))) else x).to_dict()
            else:
                calendar = {}
        except Exception:       calendar = {}

        # ── Options expiry dates ──────────────────────────────────────────
        try:
            options_dates = list(tk.options)[:8]
        except Exception:
            options_dates = []

        _log_search(sym, 'technical')
        return jsonify({
            "ticker": sym,
            "info": info,
            "financials":          financials,
            "quarterly_financials": q_financials,
            "balance_sheet":       balance_sheet,
            "quarterly_balance":   q_balance,
            "cashflow":            cashflow,
            "quarterly_cashflow":  q_cashflow,
            "recommendations":     recommendations,
            "upgrades":            upgrades,
            "institutional_holders": inst_holders,
            "major_holders":       major_holders,
            "mutual_fund_holders": mutual_fund,
            "earnings_history":    earnings_hist,
            "calendar":            calendar,
            "options_dates":       options_dates,
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 400


def _fetch_company_info(ticker: str) -> dict:
    """Fetch company name, description, sector, and exchange from Polygon reference API."""
    try:
        url = f"https://api.polygon.io/v3/reference/tickers/{ticker.upper()}?apiKey={API_KEY}"
        r = _SESSION.get(url, timeout=8)
        if r.status_code != 200:
            return {}
        data = r.json().get("results", {})
        raw_desc = data.get("description", "")
        # Truncate to ≤50 words
        words = raw_desc.split()
        short_desc = " ".join(words[:50]) + ("…" if len(words) > 50 else "")
        return {
            "name":        data.get("name", ticker.upper()),
            "description": short_desc,
            "sector":      data.get("sic_description", ""),
            "exchange":    data.get("primary_exchange", ""),
            "market_cap":  data.get("market_cap"),
            "employees":   data.get("total_employees"),
            "homepage":    data.get("homepage_url", ""),
            "list_date":   data.get("list_date", ""),
            "locale":      data.get("locale", ""),
        }
    except Exception:
        return {}


@app.route('/api/fundamentals/<ticker>')
@login_required
def api_fundamentals(ticker):
    try:
        facts = _FD.get_facts(ticker)
        if not facts:
            return jsonify({"error": f"No XBRL data for {ticker}"}), 404
        _log_search(ticker, 'fundamentals')
        items = _FD.get_line_items(facts)
        info  = _fetch_company_info(ticker)
        return jsonify({"ticker": ticker.upper(), "line_items": items, "info": info})
    except Exception as e:
        return jsonify({"error": str(e)}), 400


@app.route('/api/fundamentals/<ticker>/series/<path:line_item>')
@login_required
def api_fund_series(ticker, line_item):
    try:
        facts = _FD.get_facts(ticker)
        if not facts:
            return jsonify({"error": "No data"}), 404
        df = _FD.get_series(facts, line_item)
        if df.empty:
            return jsonify({"error": "No series data"}), 404
        result = {
            "ticker": ticker.upper(),
            "line_item": line_item,
            "periods": df["period_end"].dt.strftime('%Y-%m-%d').tolist() if "period_end" in df.columns else [],
            "labels": df["quarter_label"].tolist() if "quarter_label" in df.columns else [],
            "values": df[line_item].astype(float).tolist() if line_item in df.columns else [],
        }
        return jsonify(result)
    except Exception as e:
        return jsonify({"error": str(e)}), 400


@app.route('/api/fundamentals/<ticker>/ratios')
@login_required
def api_fund_ratios(ticker):
    try:
        facts = _FD.get_facts(ticker)
        if not facts:
            return jsonify({"error": f"No XBRL data for {ticker}"}), 404
        rows = compute_ratios(facts)
        return jsonify({"ticker": ticker.upper(), "ratios": rows})
    except Exception as e:
        return jsonify({"error": str(e)}), 400


@app.route('/api/fundamentals/<ticker>/statements')
@login_required
def api_fund_statements(ticker):
    stmt_type   = request.args.get('type', 'income').lower()
    period_type = request.args.get('period', 'annual').lower()
    if stmt_type not in ('income', 'balance', 'cashflow'):
        return jsonify({"error": "type must be income|balance|cashflow"}), 400
    if period_type not in ('annual', 'quarterly'):
        return jsonify({"error": "period must be annual|quarterly"}), 400
    schema_map = {'income': IS_SCHEMA, 'balance': BS_SCHEMA, 'cashflow': CF_SCHEMA}
    n = 8 if period_type == 'annual' else 10
    try:
        facts = _FD.get_facts(ticker)
        if not facts:
            return jsonify({"error": f"No XBRL data for {ticker}"}), 404
        result = _build_statement(facts, schema_map[stmt_type], period_type, n)
        result['ticker']      = ticker.upper()
        result['statement']   = stmt_type
        result['period_type'] = period_type
        return jsonify(result)
    except Exception as e:
        return jsonify({"error": str(e)}), 400


@app.route('/api/fundamentals/<ticker>/ai_report')
@login_required
def api_fund_ai_report(ticker):
    """Fetch the most recent 10-K or 10-Q from EDGAR, extract text, and run
    local rule-based filing analysis.  Returns a structured JSON report."""
    filing_type = request.args.get('type', '10-K').upper()
    if filing_type not in ('10-K', '10-Q'):
        return jsonify({"error": "type must be 10-K or 10-Q"}), 400

    try:
        # ── 1. Resolve CIK ────────────────────────────────────────────────
        cik = _FD.resolve_cik(ticker)
        cik_padded = str(cik).zfill(10)

        # ── 2. Fetch submissions JSON ──────────────────────────────────────
        sub_url = f"https://data.sec.gov/submissions/CIK{cik_padded}.json"
        sub = _FD._get(sub_url)
        company_name = sub.get('name', ticker.upper())

        # ── 3. Locate most-recent matching filing ──────────────────────────
        recent      = sub.get('filings', {}).get('recent', {})
        forms       = recent.get('form',            [])
        acc_nums    = recent.get('accessionNumber', [])
        filing_dates= recent.get('filingDate',      [])
        primary_docs= recent.get('primaryDocument', [])
        report_dates= recent.get('reportDate',      [])

        # Prefer exact match; fall back to amended (10-K/A, 10-Q/A)
        idx = None
        for pass_num in (0, 1):
            for i, form in enumerate(forms):
                if pass_num == 0 and form.upper() == filing_type:
                    idx = i; break
                if pass_num == 1 and form.upper().startswith(filing_type):
                    idx = i; break
            if idx is not None:
                break

        if idx is None:
            return jsonify({"error": f"No {filing_type} found for {ticker.upper()} in EDGAR."}), 404

        acc_num      = acc_nums[idx]
        filing_date  = filing_dates[idx] if idx < len(filing_dates)  else ''
        primary_doc  = primary_docs[idx] if idx < len(primary_docs)  else ''
        period_end   = report_dates[idx] if idx < len(report_dates)  else ''

        if not primary_doc:
            return jsonify({"error": "Primary document not found in filing index."}), 404

        # ── 4. Build EDGAR document URL ────────────────────────────────────
        acc_no_clean = acc_num.replace('-', '')
        doc_url = (
            f"https://www.sec.gov/Archives/edgar/data"
            f"/{cik}/{acc_no_clean}/{primary_doc}"
        )

        # ── 5. Fetch document (cap at 1.4 MB to capture MD&A in large 10-Ks) ──
        headers = {
            'User-Agent': 'FinSuite/1.0 admin@example.com',
            'Accept-Encoding': 'gzip, deflate',
        }
        _FD._throttle()
        resp = requests.get(doc_url, headers=headers, timeout=45, stream=True)
        resp.raise_for_status()

        raw_bytes = b''
        for chunk in resp.iter_content(chunk_size=32_768):
            raw_bytes += chunk
            if len(raw_bytes) >= 1_400_000:
                break
        html_text = raw_bytes.decode('utf-8', errors='ignore')

        # ── 6. Extract & truncate plain text ──────────────────────────────
        plain = _extract_filing_text(html_text)
        plain = plain[:100_000]         # ~25 k tokens — captures most 10-K sections

        # ── 7. Local rule-based analysis ─────────────────────────────────
        result = _analyze_filing_local(
            ticker=ticker.upper(),
            company_name=company_name,
            filing_type=filing_type,
            filing_date=filing_date,
            period_end=period_end,
            text=plain,
        )

        return jsonify({
            "ticker":       ticker.upper(),
            "company":      company_name,
            "filing_type":  filing_type,
            "filing_date":  filing_date,
            "period_end":   period_end,
            "doc_url":      doc_url,
            **result,           # flatten sentiment, figures, sentences, etc. to top level
        })

    except Exception as exc:
        return jsonify({"error": str(exc)}), 400


@app.route('/api/correlation', methods=['POST'])
@csrf.exempt
@login_required
def api_correlation():
    data = request.get_json()
    tickers = data.get('tickers', [])
    period = data.get('period', '1Y')
    days_map = {"6M": 180, "1Y": 365, "2Y": 730}
    days = days_map.get(period, 365)
    if len(tickers) < 2:
        return jsonify({"error": "Need at least 2 tickers"}), 400
    try:
        returns = {}
        for sym in tickers:
            df = fetch_ohlc(sym.upper(), days=days)
            returns[sym.upper()] = df["Close"].pct_change().dropna()
        ret_df = pd.DataFrame(returns).dropna()
        corr = ret_df.corr()
        return jsonify({
            "tickers": list(corr.columns),
            "matrix": corr.values.tolist()
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 400


@app.route('/api/fred/<series_id>')
@login_required
def api_fred(series_id):
    try:
        rows = fred_fetch(series_id)
        info = FRED_FLAT.get(series_id.upper(), {})
        _log_search(series_id, 'economic')
        return jsonify({
            "series_id": series_id.upper(),
            "label": info.get("label", series_id.upper()),
            "units": info.get("units", ""),
            "color": info.get("color", "#2563EB"),
            "category": info.get("category", "Custom"),
            "dates": [r["date"] for r in rows],
            "values": [r["value"] for r in rows],
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 400


@app.route('/api/fred/search')
@login_required
def api_fred_search():
    """Full-text FRED series search — proxied to avoid CORS / key exposure."""
    q = request.args.get('q', '').strip()
    if not q:
        return jsonify({"error": "No query provided"}), 400
    try:
        params = {
            "search_text":  q,
            "search_type":  "full_text",
            "api_key":      FRED_API_KEY,
            "file_type":    "json",
            "limit":        30,
            "order_by":     "popularity",
            "sort_order":   "desc",
        }
        r = _FRED_SESSION.get("https://api.stlouisfed.org/fred/series/search",
                              params=params, timeout=15)
        r.raise_for_status()
        payload = r.json()
        srs = payload.get("seriess", [])
        results = [
            {
                "id":           s["id"],
                "title":        s["title"],
                "units":        s.get("units_short", s.get("units", "")),
                "frequency":    s.get("frequency_short", ""),
                "last_obs":     (s.get("last_updated") or s.get("observation_end", ""))[:10],
                "popularity":   s.get("popularity", 0),
                "in_catalogue": s["id"] in FRED_FLAT,
                "color":        FRED_FLAT.get(s["id"], {}).get("color", "#4DA6FF"),
            }
            for s in srs
        ]
        return jsonify({"results": results})
    except Exception as e:
        return jsonify({"error": str(e)}), 400


@app.route('/api/fred/dashboard')
@login_required
def api_fred_dashboard():
    """Return recent data for 6 key macro series for the dashboard overview."""
    results = []
    for sid, label, units, color in FRED_DASHBOARD_SERIES:
        try:
            rows = fred_fetch(sid, observation_start="2015-01-01")
            if rows:
                results.append({
                    "series_id": sid, "label": label,
                    "units": units, "color": color,
                    "dates":  [r["date"]  for r in rows],
                    "values": [r["value"] for r in rows],
                })
        except Exception:
            pass
    return jsonify({"series": results})


@app.route('/api/news/<ticker>')
@login_required
def api_news(ticker):
    limit = request.args.get('limit', 50, type=int)
    try:
        articles = fetch_news(ticker, limit=limit)
        if not articles:
            return jsonify({"error": f"No news for {ticker}"}), 404
        df = parse_sentiment(articles, ticker)
        if not df.empty and "published" in df.columns:
            df["published"] = pd.to_datetime(df["published"], utc=True).dt.strftime('%Y-%m-%d %H:%M')
        _log_search(ticker, 'news')
        records = df.to_dict(orient='records')
        # Keyword frequency
        STOPWORDS = {"the","a","an","and","or","of","to","in","for","on","is","are","was",
                     "were","has","have","had","with","at","by","from","as","be","will",
                     "that","this","it","its","we","our","he","she","they","their",
                     "said","says","after","before","about","more","but","not","no","new",
                     "also","than","over","up","down","all","can","into","been","would",
                     "could","should","may","might","which","who","how","when","what",
                     "year","years","share","shares","company","stock","stocks","price",
                     "market","percent","quarter","report"}
        freq = {}
        for art in articles:
            text = (art.get("title","") + " " + art.get("description","")).lower()
            for word in text.split():
                w_clean = "".join(c for c in word if c.isalpha())
                if len(w_clean) > 3 and w_clean not in STOPWORDS:
                    freq[w_clean] = freq.get(w_clean, 0) + 1
        top_kw = sorted(freq.items(), key=lambda x: x[1], reverse=True)[:25]
        pos = sum(1 for r in records if r.get("sentiment") == "positive")
        neg = sum(1 for r in records if r.get("sentiment") == "negative")
        neu = sum(1 for r in records if r.get("sentiment") == "neutral")
        return jsonify({
            "ticker": ticker.upper(), "articles": records,
            "keywords": [{"word": w, "count": c} for w, c in top_kw],
            "summary": {"positive": pos, "negative": neg, "neutral": neu, "total": len(records)}
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 400


@app.route('/api/signal/<ticker>')
@login_required
def api_signal(ticker):
    try:
        tech_df = pd.DataFrame()
        try:
            raw = fetch_ohlc(ticker, days=730)
            tech_df = compute_indicators(raw)
        except: pass
        facts = None
        try:
            facts = _FD.get_facts(ticker)
        except: pass
        news_df = None
        try:
            articles = fetch_news(ticker, limit=50)
            if articles:
                news_df = parse_sentiment(articles, ticker)
        except: pass
        result = run_signal_engine(ticker, tech_df, facts, news_df)
        _log_search(ticker, 'signal')
        return jsonify({"ticker": ticker.upper(), **result})
    except Exception as e:
        return jsonify({"error": str(e)}), 400


@app.route('/api/backtest/<ticker>')
@login_required
def api_backtest(ticker):
    try:
        start_date = request.args.get('start_date', (datetime.today() - timedelta(days=3650)).strftime('%Y-%m-%d'))
        if start_date == 'ALL':
            start_date = '1990-01-01'
        end_date = request.args.get('end_date', datetime.today().strftime('%Y-%m-%d'))
        initial_capital = request.args.get('capital', 10000.0, type=float)
        buy_thresh = request.args.get('buy_thresh', 0.15, type=float)
        sell_thresh = request.args.get('sell_thresh', -0.15, type=float)
        lookback_days = request.args.get('lookback', 120, type=int)
        strategy = request.args.get('strategy', 'combined')
        if strategy not in ('combined', 'sma_crossover', 'momentum', 'macro_composite'):
            strategy = 'combined'
        result = run_backtest(ticker.upper(), start_date, end_date,
                              initial_capital, buy_thresh, sell_thresh, lookback_days, strategy)
        return jsonify({"ticker": ticker.upper(), "strategy": strategy, **result})
    except Exception as e:
        return jsonify({"error": str(e)}), 400


@app.route('/api/watchlist-prices')
@login_required
def api_watchlist_prices():
    tickers = current_user.watchlist_list[:15]
    results = []
    for t in tickers:
        p = fetch_latest_price(t)
        if p:
            results.append({"ticker": t, **p})
        else:
            results.append({"ticker": t, "close": None, "chg": 0, "pct": 0,
                            "high": None, "low": None, "volume": None})
    return jsonify(results)


@app.route('/api/watchlist/add', methods=['POST'])
@csrf.exempt
@login_required
def api_watchlist_add():
    data = request.get_json(silent=True) or {}
    ticker = data.get('ticker', '').strip().upper()
    if not ticker or len(ticker) > 6 or not ticker.isalpha():
        return jsonify({"error": "Invalid ticker symbol"}), 400
    tickers = current_user.watchlist_list
    if ticker not in tickers:
        if len(tickers) >= 15:
            return jsonify({"error": "Watchlist limit is 15 tickers"}), 400
        tickers.append(ticker)
        current_user.watchlist = ','.join(tickers)
        db.session.commit()
    return jsonify({"ok": True, "watchlist": tickers})


@app.route('/api/watchlist/remove', methods=['POST'])
@csrf.exempt
@login_required
def api_watchlist_remove():
    data = request.get_json(silent=True) or {}
    ticker = data.get('ticker', '').strip().upper()
    tickers = [t for t in current_user.watchlist_list if t != ticker]
    current_user.watchlist = ','.join(tickers)
    db.session.commit()
    return jsonify({"ok": True, "watchlist": tickers})


# ═══════════════════════════════════════════════════════════════════════════════
#  LISTINGS EXPLORER INTEGRATION
# ═══════════════════════════════════════════════════════════════════════════════

_LE_ROOT = os.path.normpath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'listing_explorer')
)
if _LE_ROOT not in sys.path:
    sys.path.insert(0, _LE_ROOT)

_LE_AVAILABLE = False
try:
    from loader        import load_listings          as _le_load_listings
    from filter_engine import apply_filters          as _le_apply_filters
    from fuzzy_engine  import (
        fuzzy_name_search        as _le_fuzzy_search,
        suggest_alternatives     as _le_suggest_alternatives,
        industry_keyword_search  as _le_industry_search,
    )
    from llm_parser    import parse_intent           as _le_parse_intent
    from ranker        import rank_results           as _le_rank_results
    from cache         import IntentCache            as _LeIntentCache
    _LE_AVAILABLE = True
except ImportError as _exc:
    print(f"[listings] listing_explorer modules not found — module disabled ({_exc})")

_le_df = None

def _get_le_df():
    global _le_df
    if _le_df is None and _LE_AVAILABLE:
        try:
            _le_df = _le_load_listings(os.path.join(_LE_ROOT, 'listing_status_test.xlsx'))
        except Exception as _e:
            print(f"[listings] Could not load xlsx: {_e}")
    return _le_df

_LE_NULL = {"nan", "NaT", "None", "null", "NaN", ""}

def _le_clean(val):
    s = str(val) if val is not None else ""
    return "" if s in _LE_NULL else s


@app.route('/listings')
@login_required
def listings():
    df = _get_le_df()
    le_stats = {}
    if df is not None:
        le_stats = {
            'total':     len(df),
            'exchanges': int(df['exchange'].nunique()),
            'etfs':      int((df['assetType'] == 'ETF').sum()),
            'stocks':    int((df['assetType'] == 'Stock').sum()),
            'active':    int((df['status'] == 'Active').sum()),
            'delisted':  int((df['status'] == 'Delisted').sum()),
        }
    return render_template('module.html', module='listings', le_stats=le_stats)


@app.route('/api/listings/search', methods=['POST'])
@csrf.exempt
@login_required
def api_listings_search():
    if not _LE_AVAILABLE:
        return jsonify({'error': 'Listings module not available'}), 503
    data            = request.get_json(force=True) or {}
    query           = data.get('query', '').strip()
    filters         = data.get('filters', {})
    fuzzy_threshold = int(data.get('fuzzyThreshold', 80))
    limit           = int(data.get('limit', 50))
    use_llm         = bool(data.get('useLLM', True))

    df = _get_le_df()
    if df is None:
        return jsonify({'error': 'Listings data not loaded'}), 503

    cache  = _LeIntentCache(path=os.path.join(_LE_ROOT, 'intent_cache.json'))
    intent = {}
    if query:
        cached = cache.get(query)
        intent = cached if cached else _le_parse_intent(query, use_llm=use_llm)
        if not cached:
            cache.set(query, intent)

    if filters.get('exchange'):  intent['exchange']      = filters['exchange']
    if filters.get('assetType'): intent['assetType']     = filters['assetType']
    if filters.get('status'):    intent['status']        = filters['status']
    if filters.get('ipoAfter'):  intent['ipoDate_start'] = f"{filters['ipoAfter'].strip()}-01-01"
    if filters.get('ipoBefore'): intent['ipoDate_end']   = f"{filters['ipoBefore'].strip()}-12-31"

    filtered, reasons = _le_apply_filters(df, intent)

    if hint := intent.get('industry_hint'):
        patterns = hint.lower().split()
        filtered = _le_industry_search(
            filtered if not filtered.empty else df,
            hint, name_patterns=patterns,
            threshold=fuzzy_threshold, limit=limit,
        )
    if filtered.empty and query:
        filtered = _le_fuzzy_search(df, query, threshold=fuzzy_threshold, limit=limit)

    suggestions = []
    if filtered.empty and query:
        suggestions = _le_suggest_alternatives(df, query, n=5)
    if not filtered.empty:
        filtered = _le_rank_results(filtered, intent, original_query=query)

    results = []
    for _, row in filtered.head(limit).iterrows():
        results.append({
            'symbol':         row['symbol'],
            'name':           row['name'],
            'exchange':       row['exchange'],
            'assetType':      row['assetType'],
            'ipoDate':        _le_clean(row.get('ipoDate_str')),
            'delistingDate':  _le_clean(row.get('delistingDate_str')),
            'status':         row['status'],
            'relevanceScore': float(row.get('relevance_score', 0)),
            'matchReasons':   _le_clean(row.get('match_reasons')),
        })

    return jsonify({
        'results':     results,
        'total':       len(filtered),
        'intent':      intent,
        'reasons':     reasons,
        'suggestions': [
            {'symbol': s['symbol'], 'name': s['name'], 'exchange': s['exchange'],
             'score': float(s['score']), 'matchField': s['match_field']}
            for s in suggestions
        ],
    })


@app.route('/api/listings/stats')
@login_required
def api_listings_stats():
    if not _LE_AVAILABLE:
        return jsonify({'error': 'Not available'}), 503
    df = _get_le_df()
    if df is None:
        return jsonify({'error': 'Data not loaded'}), 503
    ipo_by_year = df.groupby('ipoYear').size()
    return jsonify({
        'ipoByYear': {
            str(int(k)): int(v)
            for k, v in ipo_by_year.items()
            if pd.notna(k) and 1900 <= int(k) <= 2030
        },
        'exchangeDist': df['exchange'].value_counts().to_dict(),
        'typeDist':     df['assetType'].value_counts().to_dict(),
        'statusDist':   df['status'].value_counts().to_dict(),
    })


@app.route('/api/listings/autocomplete')
@login_required
def api_listings_autocomplete():
    if not _LE_AVAILABLE:
        return jsonify([])
    q  = request.args.get('q', '').strip()
    if not q:
        return jsonify([])
    df = _get_le_df()
    if df is None:
        return jsonify([])

    results  = []
    seen     = set()
    q_upper  = q.upper()

    # 1 — Exact symbol prefix (highest priority)
    sym_mask = df['symbol'].str.upper().str.startswith(q_upper)
    for _, r in df[sym_mask].head(5).iterrows():
        results.append({'symbol': r['symbol'], 'name': r['name'],
                        'exchange': r['exchange'], 'assetType': r['assetType'],
                        'status': r['status'], 'score': 100})
        seen.add(r['symbol'])

    # 2 — Name substring match
    name_mask = df['name'].str.contains(q, case=False, na=False) & ~sym_mask
    for _, r in df[name_mask].head(5).iterrows():
        if r['symbol'] not in seen:
            results.append({'symbol': r['symbol'], 'name': r['name'],
                            'exchange': r['exchange'], 'assetType': r['assetType'],
                            'status': r['status'], 'score': 85})
            seen.add(r['symbol'])

    # 3 — Fuzzy fallback (covers multi-word queries like "goldman sachs etfs")
    if len(results) < 10 and len(q) >= 2:
        fuzzy_hits = _le_fuzzy_search(df, q, threshold=45, limit=20)
        for _, r in fuzzy_hits.iterrows():
            if r['symbol'] not in seen:
                results.append({'symbol': r['symbol'], 'name': r['name'],
                                'exchange': r['exchange'], 'assetType': r['assetType'],
                                'status': r['status'],
                                'score': float(r.get('fuzzy_score', 50))})
                seen.add(r['symbol'])
                if len(results) >= 10:
                    break

    results.sort(key=lambda x: x['score'], reverse=True)
    return jsonify(results[:10])


@app.route('/api/listings/detail/<symbol>')
@login_required
def api_listings_detail(symbol):
    if not _LE_AVAILABLE:
        return jsonify({'error': 'Not available'}), 503
    df  = _get_le_df()
    if df is None:
        return jsonify({'error': 'Data not loaded'}), 503
    row = df[df['symbol'].str.upper() == symbol.upper()]
    if row.empty:
        return jsonify({'error': 'Not found'}), 404
    r = row.iloc[0]
    return jsonify({
        'symbol':        r['symbol'],
        'name':          r['name'],
        'exchange':      r['exchange'],
        'assetType':     r['assetType'],
        'ipoDate':       _le_clean(r.get('ipoDate_str')),
        'delistingDate': _le_clean(r.get('delistingDate_str')),
        'status':        r['status'],
        'ipoYear':       int(r['ipoYear']) if pd.notna(r.get('ipoYear')) else None,
    })


# ═══════════════════════════════════════════════════════════════════════════════
#  ALERT CENTER
# ═══════════════════════════════════════════════════════════════════════════════

@app.route('/alerts')
@login_required
def alerts_page():
    return render_template('alerts.html')


@app.route('/api/alerts', methods=['GET'])
@login_required
def api_alerts_list():
    alerts = (Alert.query
              .filter_by(user_id=current_user.id)
              .order_by(Alert.created_at.desc())
              .all())
    return jsonify([a.to_dict() for a in alerts])


@app.route('/api/alerts', methods=['POST'])
@csrf.exempt
@login_required
def api_alerts_create():
    data   = request.get_json(silent=True) or {}
    ticker = data.get('ticker', '').upper().strip()
    if not ticker:
        return jsonify({'error': 'Ticker required'}), 400
    ct = data.get('condition_type', 'price_above')
    valid_types = {
        'price_above','price_below','pct_change_above','pct_change_below',
        'rsi_above','rsi_below','macd_bull_cross','macd_bear_cross',
        'bb_upper_break','bb_lower_break','volume_spike',
        'new_52w_high','new_52w_low',
        'sma50_cross_above','sma50_cross_below',
        'sma200_cross_above','sma200_cross_below',
    }
    if ct not in valid_types:
        return jsonify({'error': 'Invalid condition type'}), 400
    expires_at = None
    if data.get('expires_at'):
        try:
            expires_at = datetime.fromisoformat(data['expires_at'])
        except Exception:
            pass
    alert = Alert(
        user_id        = current_user.id,
        ticker         = ticker,
        label          = (data.get('label') or '').strip()[:100],
        condition_type = ct,
        threshold      = data.get('threshold'),
        priority       = data.get('priority', 'medium'),
        notes          = (data.get('notes') or '').strip(),
        repeat         = bool(data.get('repeat', False)),
        expires_at     = expires_at,
    )
    db.session.add(alert)
    db.session.commit()
    return jsonify(alert.to_dict()), 201


@app.route('/api/alerts/<int:alert_id>', methods=['DELETE'])
@csrf.exempt
@login_required
def api_alerts_delete(alert_id):
    alert = Alert.query.filter_by(id=alert_id, user_id=current_user.id).first_or_404()
    db.session.delete(alert)
    db.session.commit()
    return jsonify({'ok': True})


@app.route('/api/alerts/<int:alert_id>/toggle', methods=['PUT'])
@csrf.exempt
@login_required
def api_alerts_toggle(alert_id):
    alert = Alert.query.filter_by(id=alert_id, user_id=current_user.id).first_or_404()
    alert.status = 'active' if alert.status == 'paused' else 'paused'
    db.session.commit()
    return jsonify(alert.to_dict())


@app.route('/api/alerts/<int:alert_id>/dismiss', methods=['PUT'])
@csrf.exempt
@login_required
def api_alerts_dismiss(alert_id):
    alert = Alert.query.filter_by(id=alert_id, user_id=current_user.id).first_or_404()
    alert.status = 'dismissed'
    db.session.commit()
    return jsonify(alert.to_dict())


@app.route('/api/alerts/bulk', methods=['POST'])
@csrf.exempt
@login_required
def api_alerts_bulk():
    data  = request.get_json(silent=True) or {}
    items = data.get('alerts', [])
    if not items:
        return jsonify({'created': 0, 'skipped': 0}), 200
    # Build dedup key set from existing active/paused alerts
    existing = {
        (a.ticker, a.condition_type, round(a.threshold or 0, 4))
        for a in Alert.query.filter(
            Alert.user_id == current_user.id,
            Alert.status.in_(['active', 'paused'])
        ).all()
    }
    created = skipped = 0
    for item in items:
        ticker = (item.get('ticker') or '').upper().strip()
        ct     = item.get('condition_type', '')
        th     = item.get('threshold')
        th_key = round(float(th), 4) if th is not None else 0.0
        if not ticker or not ct:
            skipped += 1; continue
        if (ticker, ct, th_key) in existing:
            skipped += 1; continue
        alert = Alert(
            user_id        = current_user.id,
            ticker         = ticker,
            label          = (item.get('label') or '')[:100],
            condition_type = ct,
            threshold      = th,
            priority       = item.get('priority', 'medium'),
            notes          = (item.get('notes') or ''),
            repeat         = bool(item.get('repeat', False)),
        )
        db.session.add(alert)
        existing.add((ticker, ct, th_key))
        created += 1
    db.session.commit()
    return jsonify({'created': created, 'skipped': skipped})


@app.route('/api/alerts/check', methods=['POST'])
@csrf.exempt
@login_required
def api_alerts_check():
    active = Alert.query.filter_by(user_id=current_user.id, status='active').all()
    # expire any past-deadline alerts first
    now = datetime.utcnow()
    for a in active:
        if a.expires_at and now > a.expires_at:
            a.status = 'expired'
    db.session.commit()
    active = [a for a in active if a.status == 'active']
    if not active:
        return jsonify({'checked': 0, 'triggered': 0, 'results': []})

    by_ticker = defaultdict(list)
    for a in active:
        by_ticker[a.ticker].append(a)

    results        = []
    triggered_count = 0

    for ticker, t_alerts in by_ticker.items():
        try:
            df_raw = fetch_ohlc(ticker, days=420)   # enough for SMA200 + 52-week
            df     = compute_indicators(df_raw)
            price  = round(float(df.iloc[-1]['Close']), 2)
            for alert in t_alerts:
                triggered, value = _check_alert_condition(alert, df)
                alert.last_checked = now
                if triggered and not (alert.status == 'triggered' and not alert.repeat):
                    alert.status          = 'triggered'
                    alert.triggered_at    = now
                    alert.triggered_value = value
                    triggered_count      += 1
                db.session.add(alert)
                results.append({
                    'id':            alert.id,
                    'ticker':        ticker,
                    'triggered':     triggered,
                    'current_price': price,
                    'value':         value,
                    'status':        alert.status,
                })
        except Exception as exc:
            for alert in t_alerts:
                results.append({'id': alert.id, 'ticker': ticker,
                                'triggered': False, 'error': str(exc)})
    db.session.commit()
    return jsonify({'checked': len(active), 'triggered': triggered_count, 'results': results})


# ═══════════════════════════════════════════════════════════════════════════════
#  TRADING JOURNAL API
# ═══════════════════════════════════════════════════════════════════════════════

@app.route('/api/journal', methods=['GET'])
@login_required
def api_journal_list():
    status = request.args.get('status', 'all')
    ticker = request.args.get('ticker', '').upper().strip()
    q = TradeJournal.query.filter_by(user_id=current_user.id)
    if status != 'all':
        q = q.filter_by(status=status)
    if ticker:
        q = q.filter(TradeJournal.ticker.ilike(f'%{ticker}%'))
    entries = q.order_by(TradeJournal.entry_date.desc(), TradeJournal.created_at.desc()).all()
    return jsonify({'entries': [e.to_dict() for e in entries]})


@app.route('/api/journal', methods=['POST'])
@login_required
def api_journal_create():
    d = request.get_json(force=True) or {}
    try:
        def _flt(val):
            return float(val) if val not in (None, '', 'null') else None
        entry_price = float(d.get('entry_price', 0) or 0)
        quantity    = float(d.get('quantity', 1) or 1)
        trade = TradeJournal(
            user_id         = current_user.id,
            ticker          = d.get('ticker', '').upper().strip(),
            company_name    = d.get('company_name', ''),
            side            = d.get('side', 'long'),
            asset_type      = d.get('asset_type', 'equity'),
            status          = d.get('status', 'open'),
            timeframe       = d.get('timeframe', ''),
            setup_type      = d.get('setup_type', ''),
            entry_date      = d.get('entry_date', ''),
            entry_price     = entry_price,
            exit_date       = d.get('exit_date') or None,
            exit_price      = _flt(d.get('exit_price')),
            quantity        = quantity,
            stop_loss       = _flt(d.get('stop_loss')),
            take_profit     = _flt(d.get('take_profit')),
            conviction      = int(d.get('conviction', 3) or 3),
            emotional_state = d.get('emotional_state', ''),
            entry_rationale = d.get('entry_rationale', ''),
            exit_rationale  = d.get('exit_rationale', ''),
            mistakes        = d.get('mistakes', ''),
            lessons         = d.get('lessons', ''),
            tags            = d.get('tags', ''),
        )
        trade._recompute()
        db.session.add(trade)
        db.session.commit()
        return jsonify({'ok': True, 'entry': trade.to_dict()})
    except Exception as e:
        db.session.rollback()
        return jsonify({'ok': False, 'error': str(e)}), 400


@app.route('/api/journal/<int:entry_id>', methods=['GET'])
@login_required
def api_journal_get(entry_id):
    entry = TradeJournal.query.filter_by(id=entry_id, user_id=current_user.id).first_or_404()
    return jsonify(entry.to_dict())


@app.route('/api/journal/<int:entry_id>', methods=['PUT'])
@login_required
def api_journal_update(entry_id):
    entry = TradeJournal.query.filter_by(id=entry_id, user_id=current_user.id).first_or_404()
    d = request.get_json(force=True) or {}
    try:
        def _flt(val):
            return float(val) if val not in (None, '', 'null') else None
        for field in ['ticker', 'company_name', 'side', 'asset_type', 'status', 'timeframe',
                      'setup_type', 'entry_date', 'exit_date', 'emotional_state',
                      'entry_rationale', 'exit_rationale', 'mistakes', 'lessons', 'tags']:
            if field in d:
                setattr(entry, field, d[field])
        if 'entry_price' in d:  entry.entry_price = float(d['entry_price'] or 0)
        if 'quantity'    in d:  entry.quantity     = float(d['quantity'] or 1)
        if 'exit_price'  in d:  entry.exit_price   = _flt(d['exit_price'])
        if 'stop_loss'   in d:  entry.stop_loss    = _flt(d['stop_loss'])
        if 'take_profit' in d:  entry.take_profit  = _flt(d['take_profit'])
        if 'conviction'  in d:  entry.conviction   = int(d['conviction'] or 3)
        entry._recompute()
        entry.updated_at = datetime.utcnow()
        db.session.commit()
        return jsonify({'ok': True, 'entry': entry.to_dict()})
    except Exception as e:
        db.session.rollback()
        return jsonify({'ok': False, 'error': str(e)}), 400


@app.route('/api/journal/<int:entry_id>', methods=['DELETE'])
@login_required
def api_journal_delete(entry_id):
    entry = TradeJournal.query.filter_by(id=entry_id, user_id=current_user.id).first_or_404()
    db.session.delete(entry)
    db.session.commit()
    return jsonify({'ok': True})


@app.route('/api/journal/stats', methods=['GET'])
@login_required
def api_journal_stats():
    entries = TradeJournal.query.filter_by(user_id=current_user.id).all()
    closed  = [e for e in entries if e.status == 'closed' and e.pnl is not None]
    open_   = [e for e in entries if e.status == 'open']
    winners = [e for e in closed if e.pnl > 0]
    losers  = [e for e in closed if e.pnl < 0]
    total_pnl      = sum(e.pnl for e in closed)
    win_rate       = round(len(winners) / len(closed) * 100, 1) if closed else 0
    avg_win        = round(sum(e.pnl for e in winners) / len(winners), 2) if winners else 0
    avg_loss       = round(sum(e.pnl for e in losers)  / len(losers),  2) if losers  else 0
    gross_win      = abs(sum(e.pnl for e in winners))
    gross_loss     = abs(sum(e.pnl for e in losers))
    profit_factor  = round(gross_win / gross_loss, 2) if gross_loss > 0 else None
    avg_rr         = None
    rr_vals        = [e.risk_reward for e in closed if e.risk_reward]
    if rr_vals:    avg_rr = round(sum(rr_vals) / len(rr_vals), 2)
    return jsonify({
        'total_trades':   len(entries),
        'open_trades':    len(open_),
        'closed_trades':  len(closed),
        'win_rate':       win_rate,
        'total_pnl':      round(total_pnl, 2),
        'avg_win':        avg_win,
        'avg_loss':       avg_loss,
        'profit_factor':  profit_factor,
        'avg_rr':         avg_rr,
        'best_trade':     round(max((e.pnl for e in closed), default=0), 2),
        'worst_trade':    round(min((e.pnl for e in closed), default=0), 2),
    })


# ═══════════════════════════════════════════════════════════════════════════════
#  TEMPLATE FILTERS
# ═══════════════════════════════════════════════════════════════════════════════

@app.template_filter('fmt_large')
def fmt_large_filter(x):
    try:
        return _fmt_large(float(x))
    except:
        return str(x)

@app.context_processor
def inject_now():
    return {'now': datetime.utcnow()}


# ═══════════════════════════════════════════════════════════════════════════════
#  INIT DB & RUN
# ═══════════════════════════════════════════════════════════════════════════════

with app.app_context():
    db.create_all()

if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0', port=5000)
