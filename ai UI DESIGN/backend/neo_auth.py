# =============================================================================
# NEXORA AUTH  —  NEXORA Browser secure authentication layer (PHASE 1)
# -----------------------------------------------------------------------------
# Responsibilities:
#   * bcrypt password hashing with transparent migration from the legacy
#     SHA-256 format used before Phase 1.
#   * Registration (explicit, no auto-create-on-login).
#   * Login by NEO username OR email.
#   * Session tokens (random, stored only as SHA-256 hashes, with expiry).
#   * Sign-out (revokes the presented token).
#   * Password reset via short-lived one-time codes (email delivery is wired
#     in a later phase; the code is returned by the request endpoint for now).
#
# Storage: keeps the existing per-user JSON layout under neo_accounts/ so all
# previously created accounts keep working. A real database replaces this in
# PHASE 2 (per the security architecture).
# =============================================================================

import os
import re
import json
import time
import secrets
import hashlib
import datetime

try:
    import bcrypt
except Exception as _e:  # pragma: no cover - deps are pre-installed via pip
    bcrypt = None

_AUTH_DIR = os.path.dirname(os.path.abspath(__file__))
NEO_ACCOUNTS_DIR = os.path.join(_AUTH_DIR, 'neo_accounts')

# ---------------------------------------------------------------------------
# Password hashing  (bcrypt, with legacy SHA-256 fallback/migration)
# ---------------------------------------------------------------------------

_SHA256_RE = re.compile(r'^[0-9a-f]{64}$')
_USERNAME_RE = re.compile(r'^[A-Za-z0-9_.\-]{3,24}$')
_EMAIL_RE = re.compile(r'^[^@\s]+@[^@\s]+\.[^@\s]+$')


def hash_password(password):
    """Return a bcrypt hash. Uses a SHA-256 pre-hash so passwords longer than
    72 bytes are handled safely (bcrypt's hard input limit)."""
    pw = str(password or '')
    if bcrypt is None:
        # Degenerate fallback if the dependency is missing — never silently.
        raise RuntimeError('bcrypt is not installed; run: pip install bcrypt')
    digest = hashlib.sha256(pw.encode('utf-8')).digest()
    return bcrypt.hashpw(digest, bcrypt.gensalt(rounds=12)).decode('utf-8')


def verify_password(password, stored_hash):
    """Check a password against a stored hash. Returns True when the stored
    hash is the legacy plain-SHA-256 format and it matches (the caller can then
    re-save the account with a bcrypt hash)."""
    pw = str(password or '')
    stored = str(stored_hash or '')
    if not stored:
        return False
    if stored.startswith('$2') and bcrypt is not None:
        digest = hashlib.sha256(pw.encode('utf-8')).digest()
        try:
            return bcrypt.checkpw(digest, stored.encode('utf-8'))
        except Exception:
            return False
    if _SHA256_RE.match(stored):
        return hmac_compare(hashlib.sha256(pw.encode('utf-8')).hexdigest(), stored)
    return False


def is_legacy_hash(stored_hash):
    return bool(_SHA256_RE.match(str(stored_hash or '')))


def hmac_compare(a, b):
    """Constant-time string comparison."""
    return secrets.compare_digest(str(a), str(b))


# ---------------------------------------------------------------------------
# Account record helpers
# ---------------------------------------------------------------------------

def _account_path(username):
    safe = re.sub(r'[^A-Za-z0-9_.\-]', '', str(username))
    if not safe:
        return None
    return os.path.join(NEO_ACCOUNTS_DIR, safe + '.json')


def _read_account(username):
    try:
        p = _account_path(username)
        if not p or not os.path.exists(p):
            return None
        with open(p, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception as e:
        print(f"[AUTH] read error {username}: {e}")
        return None


def _write_account(username, acct):
    try:
        os.makedirs(NEO_ACCOUNTS_DIR, exist_ok=True)
        p = _account_path(username)
        if not p:
            return False
        with open(p, 'w', encoding='utf-8') as f:
            json.dump(acct, f, ensure_ascii=False, indent=2)
        return True
    except Exception as e:
        print(f"[AUTH] write error {username}: {e}")
        return False


def _scan_accounts():
    """Yield every stored account record (used for email lookups)."""
    try:
        if not os.path.isdir(NEO_ACCOUNTS_DIR):
            return
        for fn in os.listdir(NEO_ACCOUNTS_DIR):
            if not fn.endswith('.json'):
                continue
            try:
                with open(os.path.join(NEO_ACCOUNTS_DIR, fn), 'r', encoding='utf-8') as f:
                    yield json.load(f)
            except Exception:
                continue
    except Exception:
        return


def find_account(identifier):
    """Resolve a NEO username or an email to (username, account) or (None, None)."""
    ident = str(identifier or '').strip()
    if not ident:
        return (None, None)
    acct = _read_account(ident)
    if acct is not None:
        return (acct.get('username', ident), acct)
    low = ident.lower()
    for a in _scan_accounts():
        if str(a.get('email', '')).strip().lower() == low:
            return (a.get('username'), a)
    return (None, None)


def normalize_username(username):
    u = str(username or '').strip()
    if not _USERNAME_RE.match(u):
        return None
    return u


def validate_email(email):
    return bool(_EMAIL_RE.match(str(email or '').strip()))


def validate_new_password(password):
    """Enforce a strong password policy: >=8 chars, one upper, one lower, one digit."""
    pw = str(password or '')
    if len(pw) < 8:
        return 'Password must be at least 8 characters'
    if not re.search(r'[A-Z]', pw):
        return 'Password must contain an uppercase letter'
    if not re.search(r'[a-z]', pw):
        return 'Password must contain a lowercase letter'
    if not re.search(r'[0-9]', pw):
        return 'Password must contain a number'
    return None


# ---------------------------------------------------------------------------
# Sessions  (token issued at login; only its SHA-256 hash is stored)
# ---------------------------------------------------------------------------

TOKEN_TTL_SECONDS = 30 * 24 * 3600  # 30 days


def create_account(username, email, password, browser_data=None):
    """Create a new account. Returns (ok_or_None, error). Account is created
    signed-out; registration also returns a fresh session token on success."""
    u = normalize_username(username)
    if u is None:
        return (None, 'Username must be 3-24 characters (letters, numbers, . _ -)')
    if not validate_email(email):
        return (None, 'Enter a valid email address')
    err = validate_new_password(password)
    if err:
        return (None, err)
    if find_account(u)[0] is not None:
        return (None, 'Username already taken')
    low_email = str(email).strip().lower()
    for a in _scan_accounts():
        if str(a.get('email', '')).strip().lower() == low_email:
            return (None, 'An account with that email already exists')
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    acct = {
        'username': u,
        'email': str(email).strip().lower(),
        'passwordHash': hash_password(password),
        'passwordVersion': 2,
        'createdAt': now,
        'updatedAt': now,
        'sessions': {},
        'resets': {},
        'data': {'browserData': browser_data or {}},
    }
    if not _write_account(u, acct):
        return (None, 'Could not save account')
    return (acct, None)


def login_account(identifier, password):
    """Authenticate by username OR email. Returns
    (acct, token, migrated) — migrated=True means the stored hash was upgraded
    to bcrypt and the account file should be re-saved."""
    username, acct = find_account(identifier)
    if acct is None:
        return (None, None, False)
    if not verify_password(password, acct.get('passwordHash', '')):
        return (None, None, False)
    migrated = is_legacy_hash(acct.get('passwordHash', ''))
    if migrated:
        acct['passwordHash'] = hash_password(password)
        acct['passwordVersion'] = 2
    token = _issue_session(acct)
    return (acct, token, migrated)


def _issue_session(acct):
    token = secrets.token_urlsafe(32)
    now = int(time.time())
    acct.setdefault('sessions', {})
    # Keep the session list bounded (oldest pruned) — cap at 20 devices.
    tokens = list(acct['sessions'].keys())
    if len(tokens) >= 20:
        tokens.sort(key=lambda th: acct['sessions'][th].get('createdAt', 0))
        for th_old in tokens[: (len(tokens) - 19)]:
            acct['sessions'].pop(th_old, None)
    acct['sessions'][_hash_token(token)] = {'createdAt': now, 'expiresAt': now + TOKEN_TTL_SECONDS}
    return token


def _hash_token(token):
    return hashlib.sha256(str(token).encode('utf-8')).hexdigest()


def validate_session(acct, token):
    """Validate a session token. Returns True/False (expired tokens are pruned)."""
    if not acct or not token:
        return False
    th = _hash_token(token)
    sess = (acct.get('sessions') or {}).get(th)
    if not sess:
        return False
    now = int(time.time())
    if int(sess.get('expiresAt', 0)) <= now:
        acct.setdefault('sessions', {}).pop(th, None)
        return False
    sess['lastUsedAt'] = now
    return True


def revoke_session(acct, token):
    if not acct or not token:
        return
    th = _hash_token(token)
    acct.setdefault('sessions', {}).pop(th, None)


def purge_expired_sessions(acct):
    now = int(time.time())
    acct.setdefault('sessions', {})
    for th in [k for k, v in acct['sessions'].items() if int(v.get('expiresAt', 0)) <= now]:
        acct['sessions'].pop(th, None)


# ---------------------------------------------------------------------------
# Password reset  (one-time codes, hashed at rest, 30-minute TTL)
# ---------------------------------------------------------------------------

RESET_TTL_SECONDS = 30 * 60


def request_password_reset(identifier):
    """Issue a reset code for username-or-email. Returns (username, code) or (None, None)."""
    username, acct = find_account(identifier)
    if acct is None:
        return (None, None)
    if not acct.get('email'):
        return (None, None)
    code = secrets.token_hex(5)  # 10-char one-time code
    now = int(time.time())
    acct.setdefault('resets', {})
    acct['resets'][_hash_token(code.lower())] = {'createdAt': now, 'expiresAt': now + RESET_TTL_SECONDS, 'username': username}
    if not _write_account(username, acct):
        return (None, None)
    return (username, code)


def reset_password(identifier, code, new_password):
    """Consume a reset code and set a new password. Returns (ok, error)."""
    err = validate_new_password(new_password)
    if err:
        return (None, err)
    username, acct = find_account(identifier)
    if acct is None:
        return (None, 'Reset code is invalid or has expired')
    _purge_expired_resets(acct)
    ch = _hash_token(str(code).strip().lower())
    entry = (acct.get('resets') or {}).get(ch)
    if not entry:
        return (None, 'Reset code is invalid or has expired')
    if str(entry.get('username', '')) != str(username):
        return (None, 'Reset code mismatch')
    acct['passwordHash'] = hash_password(new_password)
    acct['passwordVersion'] = 2
    acct['updatedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    # Revoke all sessions after a password reset.
    acct['sessions'] = {}
    acct['resets'].pop(ch, None)
    _write_account(username, acct)
    return (username, None)


def _purge_expired_resets(acct):
    now = int(time.time())
    acct.setdefault('resets', {})
    for k in [k for k, v in acct['resets'].items() if int(v.get('expiresAt', 0)) <= now]:
        acct['resets'].pop(k, None)


def change_password(acct, new_password):
    err = validate_new_password(new_password)
    if err:
        return (None, err)
    acct['passwordHash'] = hash_password(new_password)
    acct['passwordVersion'] = 2
    acct['updatedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    _write_account(acct.get('username'), acct)
    return (acct.get('username'), None)


# ---------------------------------------------------------------------------
# Small helpers for route handlers
# ---------------------------------------------------------------------------

def auth_ok(acct, body):
    """Authenticate a route using a token (preferred) or password (legacy).
    Returns True when the caller may proceed; prunes expired sessions."""
    if not acct:
        return False
    purge_expired_sessions(acct)
    token = body.get('token')
    if token and validate_session(acct, token):
        return True
    return False