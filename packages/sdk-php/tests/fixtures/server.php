<?php

declare(strict_types=1);

// Router for `php -S`: records each request next to this file and answers
// like Kinglet's ingest endpoint would, depending on the path.

$record = [
    'path' => parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH),
    'method' => $_SERVER['REQUEST_METHOD'] ?? '',
    'authorization' => $_SERVER['HTTP_AUTHORIZATION'] ?? '',
    'contentType' => $_SERVER['CONTENT_TYPE'] ?? $_SERVER['HTTP_CONTENT_TYPE'] ?? '',
    'userAgent' => $_SERVER['HTTP_USER_AGENT'] ?? '',
    'body' => (string) file_get_contents('php://input'),
];

file_put_contents(getenv('KINGLET_TEST_LOG') ?: __DIR__ . '/requests.log', json_encode($record) . "\n", FILE_APPEND);

if (str_starts_with((string) $record['path'], '/slow')) {
    usleep(1_500_000);
}

if (str_starts_with((string) $record['path'], '/unauthorized')) {
    http_response_code(401);
    header('Content-Type: application/json');
    echo '{"error":"invalid key"}';

    return true;
}

header('Content-Type: application/json');
echo json_encode(['accepted' => substr_count($record['body'], "\n") + 1, 'rejected' => 0]);

return true;
