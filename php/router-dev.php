<?php
// Local testing only: php -S localhost:8080 router-dev.php (emulates .htaccess)
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
if (preg_match('#^/(data(/|$)|config\.php|.*\.html$)#', $path)) {
    http_response_code(403);
    exit;
}
if ($path !== '/' && is_file(__DIR__ . $path)) {
    if (str_ends_with($path, '.mjs')) {
        header('Content-Type: text/javascript');
        readfile(__DIR__ . $path);
        exit;
    }
    return false;
}
require __DIR__ . '/index.php';
