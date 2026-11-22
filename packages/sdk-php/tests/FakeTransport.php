<?php

declare(strict_types=1);

namespace Kinglet\Tests;

use Kinglet\Transport\Result;
use Kinglet\Transport\Transport;

/** Records every request and answers with queued results (200 by default). */
final class FakeTransport implements Transport
{
    /** @var list<array{url: string, token: string, body: string}> */
    public array $requests = [];

    /** @var list<Result> */
    private array $results = [];

    public function willReturn(Result ...$results): self
    {
        $this->results = array_values([...$this->results, ...$results]);

        return $this;
    }

    public function send(string $url, string $token, string $body, float $timeout): Result
    {
        $this->requests[] = ['url' => $url, 'token' => $token, 'body' => $body];

        return array_shift($this->results) ?? new Result(200, '{"accepted":1}');
    }

    /**
     * The events of one request, decoded.
     *
     * @return list<array<string, mixed>>
     */
    public function events(int $request = 0): array
    {
        $body = $this->requests[$request]['body'] ?? '';

        return array_map(
            static fn (string $line): array => json_decode($line, true, 512, JSON_THROW_ON_ERROR),
            $body === '' ? [] : explode("\n", $body),
        );
    }

    /** @return list<string> */
    public function messages(): array
    {
        $messages = [];

        foreach (array_keys($this->requests) as $index) {
            foreach ($this->events($index) as $event) {
                $messages[] = (string) $event['message'];
            }
        }

        return $messages;
    }
}
