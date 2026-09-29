<?php
// Front controller for PHP hosting (e.g. Hostinger shared hosting via FTP).
// Implements the same routes as server/server.js: pages, email/password auth
// and the per-user preset library. Photos are analysed in the browser only.
declare(strict_types=1);

const DATA_DIR = __DIR__ . '/data';
const SESSION_TTL = 30 * 24 * 60 * 60;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 256;
const MAX_PRESETS = 1000;
const MAX_TEXT = 4 * 1024 * 1024;
const LOGIN_LIMIT = 10;
const LOGIN_WINDOW = 15 * 60;

$config = is_file(__DIR__ . '/config.php') ? (require __DIR__ . '/config.php') : [];
$allowRegistration = (bool)($config['allow_registration'] ?? true);

class HttpError extends Exception
{
    public int $status;

    public function __construct(int $status, string $message)
    {
        parent::__construct($message);
        $this->status = $status;
    }
}

function security_headers(): void
{
    header("Content-Security-Policy: default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; "
        . "script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    header('X-Content-Type-Options: nosniff');
    header('Referrer-Policy: no-referrer');
    header('X-Frame-Options: DENY');
}

function send_json(int $status, array $data): void
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function redirect(string $location): void
{
    header('Location: ' . $location, true, 302);
    header('Cache-Control: no-store');
    exit;
}

function serve_page(string $file): void
{
    header('Content-Type: text/html; charset=utf-8');
    header('Cache-Control: no-store');
    readfile(__DIR__ . '/' . $file);
    exit;
}

// --- JSON storage with file locks ---------------------------------------------

function ensure_data_dir(): void
{
    if (!is_dir(DATA_DIR)) {
        mkdir(DATA_DIR, 0700, true);
    }
    $ht = DATA_DIR . '/.htaccess';
    if (!is_file($ht)) {
        file_put_contents($ht, "Require all denied\nDeny from all\n");
    }
    $idx = DATA_DIR . '/index.html';
    if (!is_file($idx)) {
        file_put_contents($idx, '');
    }
}

function store_path(string $name): string
{
    if (!preg_match('/^[a-zA-Z0-9_.-]+$/', $name)) {
        throw new RuntimeException('Invalid store name');
    }
    return DATA_DIR . '/' . $name;
}

function store_read(string $name, $fallback)
{
    $path = store_path($name);
    if (!is_file($path)) {
        return $fallback;
    }
    $fh = fopen($path, 'rb');
    flock($fh, LOCK_SH);
    $raw = stream_get_contents($fh);
    flock($fh, LOCK_UN);
    fclose($fh);
    $data = json_decode((string)$raw, true);
    return is_array($data) ? $data : $fallback;
}

// Runs $mutator(&$data) under an exclusive lock and saves the result.
function store_update(string $name, $fallback, callable $mutator)
{
    ensure_data_dir();
    $path = store_path($name);
    $fh = fopen($path, 'c+b');
    if (!$fh) {
        throw new RuntimeException('Cannot open data file');
    }
    try {
        flock($fh, LOCK_EX);
        $raw = stream_get_contents($fh);
        $data = $raw !== '' ? json_decode((string)$raw, true) : null;
        if (!is_array($data)) {
            $data = $fallback;
        }
        $result = $mutator($data);
        ftruncate($fh, 0);
        rewind($fh);
        fwrite($fh, json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT));
        fflush($fh);
        return $result;
    } finally {
        flock($fh, LOCK_UN);
        fclose($fh);
    }
}

// --- Helpers -------------------------------------------------------------------

function uuid4(): string
{
    $b = random_bytes(16);
    $b[6] = chr((ord($b[6]) & 0x0f) | 0x40);
    $b[8] = chr((ord($b[8]) & 0x3f) | 0x80);
    return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($b), 4));
}

function is_https(): bool
{
    return (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
        || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https')
        || (($_SERVER['SERVER_PORT'] ?? '') === '443');
}

function read_json(): array
{
    $type = $_SERVER['CONTENT_TYPE'] ?? $_SERVER['HTTP_CONTENT_TYPE'] ?? '';
    if (strpos($type, 'application/json') !== 0) {
        throw new HttpError(415, 'Tikimasi JSON.');
    }
    $raw = file_get_contents('php://input', false, null, 0, 10 * 1024 * 1024 + 1);
    if (strlen((string)$raw) > 10 * 1024 * 1024) {
        throw new HttpError(413, 'Užklausa per didelė.');
    }
    $data = json_decode($raw ?: '{}', true);
    if (!is_array($data)) {
        throw new HttpError(400, 'Netinkamas JSON.');
    }
    return $data;
}

function check_origin(): void
{
    $origin = $_SERVER['HTTP_ORIGIN'] ?? '';
    if ($origin === '') {
        return;
    }
    $host = parse_url($origin, PHP_URL_HOST);
    $port = parse_url($origin, PHP_URL_PORT);
    $originHost = $host . ($port ? ':' . $port : '');
    $expected = $_SERVER['HTTP_X_FORWARDED_HOST'] ?? $_SERVER['HTTP_HOST'] ?? '';
    if (strcasecmp($originHost, $expected) !== 0) {
        throw new HttpError(403, 'Netinkama kilmė.');
    }
}

function clean_text($value, int $max): string
{
    $s = preg_replace('/[\x00-\x1f]/u', ' ', (string)($value ?? ''));
    return mb_substr(trim((string)$s), 0, $max);
}

// --- Sessions ------------------------------------------------------------------

const COOKIE = 'lpd_session';

function set_session_cookie(string $token, int $maxAge): void
{
    setcookie(COOKIE, $token, [
        'expires' => $maxAge > 0 ? time() + $maxAge : time() - 3600,
        'path' => '/',
        'secure' => is_https(),
        'httponly' => true,
        'samesite' => 'Strict',
    ]);
}

function create_session(string $userId): string
{
    $token = rtrim(strtr(base64_encode(random_bytes(32)), '+/', '-_'), '=');
    $now = time();
    store_update('sessions.json', [], function (array &$sessions) use ($token, $userId, $now) {
        foreach ($sessions as $k => $s) {
            if (($s['expires'] ?? 0) < $now) {
                unset($sessions[$k]);
            }
        }
        $sessions[hash('sha256', $token)] = ['userId' => $userId, 'created' => $now, 'expires' => $now + SESSION_TTL];
    });
    return $token;
}

function find_user(callable $pred): ?array
{
    foreach (store_read('users.json', []) as $u) {
        if ($pred($u)) {
            return $u;
        }
    }
    return null;
}

function public_user(array $u): array
{
    return ['id' => $u['id'], 'email' => $u['email'], 'createdAt' => $u['createdAt']];
}

function current_token(): string
{
    return (string)($_COOKIE[COOKIE] ?? '');
}

function current_user(): ?array
{
    $token = current_token();
    if ($token === '') {
        return null;
    }
    $sessions = store_read('sessions.json', []);
    $s = $sessions[hash('sha256', $token)] ?? null;
    if (!$s || $s['expires'] < time()) {
        return null;
    }
    $user = find_user(fn($u) => $u['id'] === $s['userId']);
    return $user ? public_user($user) : null;
}

function require_user(): array
{
    $user = current_user();
    if (!$user) {
        throw new HttpError(401, 'Reikia prisijungti.');
    }
    return $user;
}

function validate_password($password): void
{
    if (!is_string($password) || mb_strlen($password) < PASSWORD_MIN) {
        throw new HttpError(400, 'Slaptažodis turi būti bent ' . PASSWORD_MIN . ' simbolių.');
    }
    if (mb_strlen($password) > PASSWORD_MAX) {
        throw new HttpError(400, 'Slaptažodis per ilgas.');
    }
}

function normalize_email($email): string
{
    return mb_strtolower(trim((string)($email ?? '')));
}

function register_user($rawEmail, $password): void
{
    $email = normalize_email($rawEmail);
    if (!preg_match('/^[^\s@]+@[^\s@]+\.[^\s@]+$/u', $email) || strlen($email) > 254) {
        throw new HttpError(400, 'Neteisingas el. pašto adresas.');
    }
    validate_password($password);
    $hash = password_hash($password, PASSWORD_DEFAULT);
    store_update('users.json', [], function (array &$users) use ($email, $hash) {
        foreach ($users as $u) {
            if ($u['email'] === $email) {
                throw new HttpError(409, 'Paskyra su šiuo el. paštu jau egzistuoja.');
            }
        }
        $users[] = ['id' => uuid4(), 'email' => $email, 'passwordHash' => $hash, 'createdAt' => gmdate('c')];
    });
}

function login_user($rawEmail, $password): array
{
    $email = normalize_email($rawEmail);
    $user = find_user(fn($u) => $u['email'] === $email);
    $password = (string)($password ?? '');
    if (!$user) {
        password_verify($password, password_hash('timing-equalizer', PASSWORD_DEFAULT));
        throw new HttpError(401, 'Neteisingas el. paštas arba slaptažodis.');
    }
    if (!password_verify($password, $user['passwordHash'])) {
        throw new HttpError(401, 'Neteisingas el. paštas arba slaptažodis.');
    }
    return $user;
}

// --- Login rate limiting ----------------------------------------------------------

function rate_key(string $email): string
{
    return hash('sha256', ($_SERVER['REMOTE_ADDR'] ?? '') . '|' . mb_strtolower($email));
}

function rate_blocked(string $key): bool
{
    $hits = store_read('ratelimit.json', []);
    $e = $hits[$key] ?? null;
    return $e && time() - $e['start'] <= LOGIN_WINDOW && $e['count'] >= LOGIN_LIMIT;
}

function rate_fail(string $key): void
{
    store_update('ratelimit.json', [], function (array &$hits) use ($key) {
        $now = time();
        foreach ($hits as $k => $e) {
            if ($now - $e['start'] > LOGIN_WINDOW) {
                unset($hits[$k]);
            }
        }
        if (!isset($hits[$key])) {
            $hits[$key] = ['start' => $now, 'count' => 0];
        }
        $hits[$key]['count']++;
    });
}

function rate_reset(string $key): void
{
    store_update('ratelimit.json', [], function (array &$hits) use ($key) {
        unset($hits[$key]);
    });
}

// --- API -------------------------------------------------------------------------

function presets_file(string $userId): string
{
    return 'presets-' . $userId . '.json';
}

function preset_meta(array $p): array
{
    unset($p['xmp'], $p['lrtemplate']);
    return $p;
}

function safe_file_name(string $name, string $ext): string
{
    $base = trim((string)preg_replace('/[\\\\\/:*?"<>|\x00-\x1f]/u', '_', $name));
    return ($base !== '' ? $base : 'preset') . $ext;
}

function handle_api(string $path, string $method, bool $allowRegistration): void
{
    if ($method !== 'GET' && $method !== 'HEAD') {
        check_origin();
    }

    if ($path === '/api/auth/config' && $method === 'GET') {
        send_json(200, ['allowRegistration' => $allowRegistration]);
    }

    if ($path === '/api/auth/register' && $method === 'POST') {
        if (!$allowRegistration) {
            throw new HttpError(403, 'Registracija išjungta. Kreipkitės į administratorių.');
        }
        $body = read_json();
        register_user($body['email'] ?? '', $body['password'] ?? '');
        $user = login_user($body['email'] ?? '', $body['password'] ?? '');
        set_session_cookie(create_session($user['id']), SESSION_TTL);
        send_json(201, ['user' => public_user($user)]);
    }

    if ($path === '/api/auth/login' && $method === 'POST') {
        $body = read_json();
        $key = rate_key((string)($body['email'] ?? ''));
        if (rate_blocked($key)) {
            throw new HttpError(429, 'Per daug nesėkmingų bandymų. Pabandykite po 15 minučių.');
        }
        try {
            $user = login_user($body['email'] ?? '', $body['password'] ?? '');
        } catch (HttpError $e) {
            if ($e->status === 401) {
                rate_fail($key);
            }
            throw $e;
        }
        rate_reset($key);
        set_session_cookie(create_session($user['id']), SESSION_TTL);
        send_json(200, ['user' => public_user($user)]);
    }

    if ($path === '/api/auth/logout' && $method === 'POST') {
        $token = current_token();
        if ($token !== '') {
            store_update('sessions.json', [], function (array &$s) use ($token) {
                unset($s[hash('sha256', $token)]);
            });
        }
        set_session_cookie('', 0);
        send_json(200, ['ok' => true]);
    }

    if ($path === '/api/auth/me' && $method === 'GET') {
        send_json(200, ['user' => require_user()]);
    }

    if ($path === '/api/auth/password' && $method === 'POST') {
        $user = require_user();
        $body = read_json();
        $full = find_user(fn($u) => $u['id'] === $user['id']);
        if (!$full || !password_verify((string)($body['currentPassword'] ?? ''), $full['passwordHash'])) {
            throw new HttpError(401, 'Dabartinis slaptažodis neteisingas.');
        }
        validate_password($body['newPassword'] ?? null);
        $hash = password_hash($body['newPassword'], PASSWORD_DEFAULT);
        store_update('users.json', [], function (array &$users) use ($user, $hash) {
            foreach ($users as &$u) {
                if ($u['id'] === $user['id']) {
                    $u['passwordHash'] = $hash;
                }
            }
        });
        store_update('sessions.json', [], function (array &$sessions) use ($user) {
            foreach ($sessions as $k => $s) {
                if ($s['userId'] === $user['id']) {
                    unset($sessions[$k]);
                }
            }
        });
        set_session_cookie(create_session($user['id']), SESSION_TTL);
        send_json(200, ['ok' => true]);
    }

    if ($path === '/api/presets' && $method === 'GET') {
        $user = require_user();
        $list = array_map('preset_meta', store_read(presets_file($user['id']), []));
        send_json(200, ['presets' => $list]);
    }

    if ($path === '/api/presets' && $method === 'POST') {
        $user = require_user();
        $body = read_json();
        $name = clean_text($body['name'] ?? '', 200);
        $xmp = (string)($body['xmp'] ?? '');
        $lrtemplate = (string)($body['lrtemplate'] ?? '');
        if ($name === '') {
            throw new HttpError(400, 'Preseto pavadinimas privalomas.');
        }
        if (strpos($xmp, 'camera-raw-settings') === false) {
            throw new HttpError(400, 'Netinkamas preseto XMP.');
        }
        if (strlen($xmp) > MAX_TEXT || strlen($lrtemplate) > MAX_TEXT) {
            throw new HttpError(413, 'Presetas per didelis.');
        }
        $preset = [
            'id' => uuid4(),
            'name' => $name,
            'group' => clean_text($body['group'] ?? '', 200),
            'sourceFile' => clean_text($body['sourceFile'] ?? '', 300),
            'camera' => clean_text($body['camera'] ?? '', 200),
            'settingsCount' => is_int($body['settingsCount'] ?? null) ? $body['settingsCount'] : null,
            'createdAt' => gmdate('c'),
            'xmp' => $xmp,
            'lrtemplate' => $lrtemplate,
        ];
        store_update(presets_file($user['id']), [], function (array &$presets) use ($preset) {
            if (count($presets) >= MAX_PRESETS) {
                throw new HttpError(409, 'Pasiektas limitas: ' . MAX_PRESETS . ' presetų.');
            }
            array_unshift($presets, $preset);
        });
        send_json(201, ['preset' => preset_meta($preset)]);
    }

    if (preg_match('#^/api/presets/([0-9a-f-]{36})(\.xmp|\.lrtemplate)?$#', $path, $m)) {
        $user = require_user();
        $id = $m[1];
        $ext = $m[2] ?? '';
        if ($method === 'DELETE' && $ext === '') {
            $removed = store_update(presets_file($user['id']), [], function (array &$presets) use ($id) {
                foreach ($presets as $i => $p) {
                    if ($p['id'] === $id) {
                        array_splice($presets, $i, 1);
                        return true;
                    }
                }
                return false;
            });
            if (!$removed) {
                throw new HttpError(404, 'Presetas nerastas.');
            }
            send_json(200, ['ok' => true]);
        }
        if ($method === 'GET') {
            $preset = null;
            foreach (store_read(presets_file($user['id']), []) as $p) {
                if ($p['id'] === $id) {
                    $preset = $p;
                }
            }
            if (!$preset) {
                throw new HttpError(404, 'Presetas nerastas.');
            }
            if ($ext === '') {
                send_json(200, ['preset' => preset_meta($preset)]);
            }
            $body = $ext === '.xmp' ? $preset['xmp'] : $preset['lrtemplate'];
            if ($body === '') {
                throw new HttpError(404, 'Šis formatas neišsaugotas.');
            }
            $fileName = safe_file_name($preset['name'], $ext);
            header('Content-Type: ' . ($ext === '.xmp' ? 'application/rdf+xml' : 'text/plain') . '; charset=utf-8');
            header('Content-Disposition: attachment; filename="preset' . $ext . '"; filename*=UTF-8\'\'' . rawurlencode($fileName));
            header('Cache-Control: no-store');
            echo $body;
            exit;
        }
    }

    throw new HttpError(404, 'Nerasta.');
}

// --- Dispatch ----------------------------------------------------------------------

security_headers();
$path = (string)parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);
$path = '/' . ltrim($path, '/');
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

try {
    if (strpos($path, '/api/') === 0) {
        handle_api($path, $method, $allowRegistration);
    }
    if ($path === '/' || $path === '/index.php') {
        redirect(current_user() ? '/app' : '/login');
    }
    if ($path === '/login') {
        if (current_user()) {
            redirect('/app');
        }
        serve_page('login.html');
    }
    if ($path === '/app') {
        if (!current_user()) {
            redirect('/login');
        }
        serve_page('app.html');
    }
    http_response_code(404);
    header('Content-Type: text/plain; charset=utf-8');
    echo 'Not found';
} catch (HttpError $e) {
    if (strpos($path, '/api/') === 0) {
        send_json($e->status, ['error' => $e->getMessage()]);
    }
    http_response_code($e->status);
    echo $e->getMessage();
} catch (Throwable $e) {
    error_log((string)$e);
    if (strpos($path, '/api/') === 0) {
        send_json(500, ['error' => 'Serverio klaida.']);
    }
    http_response_code(500);
    echo 'Server error';
}
