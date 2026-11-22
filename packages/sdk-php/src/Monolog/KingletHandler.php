<?php

declare(strict_types=1);

namespace Kinglet\Monolog;

use Kinglet\Client;
use Kinglet\Level as KingletLevel;
use Monolog\Handler\AbstractProcessingHandler;
use Monolog\Level;
use Monolog\LogRecord;

/**
 * A Monolog 3 handler that sends records to Kinglet, for Laravel, Symfony, or
 * any Monolog setup.
 *
 * Pass a configured Client, or the plain settings (handy in framework config
 * files); with neither, KINGLET_URL and KINGLET_KEY are read from the
 * environment. The record's context becomes the event's fields, and its
 * channel and non-empty `extra` are added as `channel` and `extra`.
 */
final class KingletHandler extends AbstractProcessingHandler
{
    private readonly Client $client;

    public function __construct(
        ?Client $client = null,
        ?string $url = null,
        ?string $token = null,
        ?string $service = null,
        ?string $env = null,
        int|string|Level $level = Level::Debug,
        bool $bubble = true,
    ) {
        parent::__construct($level, $bubble);

        $this->client = $client ?? Client::fromEnvironment(array_filter(
            ['url' => $url, 'token' => $token, 'service' => $service, 'env' => $env],
            static fn (?string $value): bool => $value !== null && $value !== '',
        ));
    }

    public function client(): Client
    {
        return $this->client;
    }

    protected function write(LogRecord $record): void
    {
        $fields = $record->context;

        if (!array_key_exists('channel', $fields)) {
            $fields['channel'] = $record->channel;
        }

        if ($record->extra !== [] && !array_key_exists('extra', $fields)) {
            $fields['extra'] = $record->extra;
        }

        $this->client->log(
            KingletLevel::fromName($record->level->toPsrLogLevel()),
            $record->message,
            $fields,
            $record->datetime,
        );
    }

    /** Sends whatever is buffered; Monolog calls this on close and reset. */
    public function close(): void
    {
        $this->client->flush();
        parent::close();
    }

    public function reset(): void
    {
        $this->client->flush();
        parent::reset();
    }
}
