<?php

declare(strict_types=1);

namespace Kinglet\Transport;

/**
 * POSTs a batch with ext-curl when it's loaded, or PHP streams otherwise.
 * Short connect and total timeouts keep a slow or unreachable Kinglet from
 * holding up the request it's logging.
 */
final class HttpTransport implements Transport
{
    private readonly bool $useCurl;

    /** @param bool|null $useCurl Force curl (true) or streams (false); default: curl when loaded */
    public function __construct(?bool $useCurl = null)
    {
        $this->useCurl = ($useCurl ?? true) && function_exists('curl_init');
    }

    public function send(string $url, string $token, string $body, float $timeout): Result
    {
        return $this->useCurl
            ? $this->sendWithCurl($url, $token, $body, $timeout)
            : $this->sendWithStreams($url, $token, $body, $timeout);
    }

    /** @return list<string> */
    private function headers(string $token, string $body): array
    {
        return [
            'Authorization: Bearer ' . $token,
            'Content-Type: application/x-ndjson',
            'Content-Length: ' . strlen($body),
            'User-Agent: kinglet-sdk-php/' . \Kinglet\Client::VERSION,
        ];
    }

    private function sendWithCurl(string $url, string $token, string $body, float $timeout): Result
    {
        $handle = curl_init($url);

        if ($handle === false) {
            return new Result(null, '', 'curl_init failed');
        }

        curl_setopt_array($handle, [
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => $body,
            CURLOPT_HTTPHEADER => $this->headers($token, $body),
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CONNECTTIMEOUT_MS => (int) max(1, min($timeout, 2.0) * 1000),
            CURLOPT_TIMEOUT_MS => (int) max(1, $timeout * 1000),
            CURLOPT_NOSIGNAL => true,
        ]);

        $response = curl_exec($handle);

        if ($response === false) {
            return new Result(null, '', curl_error($handle) ?: 'request failed');
        }

        $status = (int) curl_getinfo($handle, CURLINFO_RESPONSE_CODE);

        return new Result($status, is_string($response) ? $response : '');
    }

    private function sendWithStreams(string $url, string $token, string $body, float $timeout): Result
    {
        $context = stream_context_create([
            'http' => [
                'method' => 'POST',
                'header' => implode("\r\n", $this->headers($token, $body)),
                'content' => $body,
                'timeout' => $timeout,
                'ignore_errors' => true,
            ],
        ]);

        $error = null;
        set_error_handler(static function (int $_severity, string $message) use (&$error): bool {
            $error = $message;

            return true;
        });

        try {
            $response = file_get_contents($url, false, $context);
        } finally {
            restore_error_handler();
        }

        $statusLine = function_exists('http_get_last_response_headers')
            ? (http_get_last_response_headers()[0] ?? '')
            : ($http_response_header[0] ?? '');

        if ($response === false || !preg_match('#^HTTP/\S+\s+(\d{3})#', $statusLine, $match)) {
            return new Result(null, '', $error ?? 'request failed');
        }

        return new Result((int) $match[1], $response);
    }
}
