<?php

declare(strict_types=1);

namespace Kinglet\Tests;

use Kinglet\Client;
use Kinglet\KingletException;
use Kinglet\Level;
use Kinglet\Transport\Result;
use PHPUnit\Framework\TestCase;

final class ClientTest extends TestCase
{
    private FakeTransport $transport;

    /** @var list<KingletException> */
    private array $errors = [];

    protected function setUp(): void
    {
        $this->transport = new FakeTransport();
        $this->errors = [];
    }

    /** @param array<string, mixed> $options */
    private function client(array $options = []): Client
    {
        return new Client(...[
            'url' => 'https://logs.example.com/',
            'token' => 'kl_test',
            'service' => 'api',
            'env' => 'prod',
            'flushInterval' => 3600.0,
            'flushOnShutdown' => false,
            'onError' => function (KingletException $error): void {
                $this->errors[] = $error;
            },
            'transport' => $this->transport,
            ...$options,
        ]);
    }

    public function testBuffersUntilTheBatchIsFullThenSendsOneRequest(): void
    {
        $client = $this->client(['batchSize' => 3]);

        $client->info('one');
        $client->info('two');
        self::assertCount(0, $this->transport->requests);

        $client->info('three');
        self::assertCount(1, $this->transport->requests);
        self::assertSame(['one', 'two', 'three'], $this->transport->messages());
        self::assertSame(0, $client->pending());
    }

    public function testSendsNdjsonWithTheEventShapeKingletExpects(): void
    {
        $client = $this->client();

        $client->warn('payment retried', ['id' => 'pay_42', 'attempt' => 2]);
        $client->flush();

        $request = $this->transport->requests[0];
        [$event] = $this->transport->events();

        self::assertSame('https://logs.example.com/v1/events', $request['url']);
        self::assertSame('kl_test', $request['token']);
        self::assertSame('warn', $event['level']);
        self::assertSame('payment retried', $event['message']);
        self::assertSame('api', $event['service']);
        self::assertSame('prod', $event['env']);
        self::assertSame(['id' => 'pay_42', 'attempt' => 2], $event['fields']);
        self::assertIsInt($event['ts']);
        self::assertEqualsWithDelta(microtime(true) * 1000, $event['ts'], 5000);
    }

    public function testSendsListShapedFieldsAsAJsonObject(): void
    {
        $client = $this->client();

        $client->info('list', ['a', 'b']);
        $client->flush();

        self::assertStringContainsString('"fields":{"0":"a","1":"b"}', $this->transport->requests[0]['body']);
    }

    public function testUsesTheGivenTimeAndLevelName(): void
    {
        $client = $this->client();

        $client->log('critical', 'disk full', [], new \DateTimeImmutable('2026-01-02T03:04:05.678Z'));
        $client->flush();

        [$event] = $this->transport->events();

        self::assertSame('fatal', $event['level']);
        self::assertSame(1767323045678, $event['ts']);
    }

    public function testNeverSendsAnEmptyMessage(): void
    {
        $client = $this->client();

        $client->info('   ');
        $client->flush();

        self::assertSame(['(empty message)'], $this->transport->messages());
    }

    public function testFlushesWhenTheIntervalHasPassed(): void
    {
        $client = $this->client(['flushInterval' => 0.0]);

        $client->info('right away');

        self::assertCount(1, $this->transport->requests);
    }

    public function testKeepsAFailedBatchAndSendsItOnTheNextFlush(): void
    {
        $client = $this->client();
        $this->transport->willReturn(new Result(null, '', 'Connection refused'));

        $client->info('kept');

        self::assertFalse($client->flush());
        self::assertSame(1, $client->pending());
        self::assertCount(1, $this->errors);
        self::assertStringContainsString('Connection refused', $this->errors[0]->getMessage());

        self::assertTrue($client->flush());
        self::assertSame(0, $client->pending());
        self::assertSame(['kept', 'kept'], $this->transport->messages());
    }

    public function testBacksOffAutomaticSendsAfterAFailure(): void
    {
        $client = $this->client(['batchSize' => 1]);
        $this->transport->willReturn(new Result(503));

        $client->info('first');
        $client->info('second');
        $client->info('third');

        // Only the first log call tried; the rest wait out the backoff.
        self::assertCount(1, $this->transport->requests);
        self::assertSame(3, $client->pending());
    }

    public function testDropsABatchKingletRejectsInsteadOfRetryingIt(): void
    {
        $client = $this->client();
        $this->transport->willReturn(new Result(401, '{"error":"invalid key"}'));

        $client->info('bad key');

        self::assertTrue($client->flush());
        self::assertSame(0, $client->pending());
        self::assertSame(401, $this->errors[0]->status);
        self::assertSame(1, $this->errors[0]->events);
        self::assertStringContainsString('invalid key', $this->errors[0]->getMessage());
    }

    public function testCapsTheBufferAndKeepsTheNewestEvents(): void
    {
        $client = $this->client(['batchSize' => 2, 'maxBuffered' => 4]);
        $this->transport->willReturn(new Result(503));

        // The first full batch fails and starts the backoff; nothing else sends.
        for ($i = 1; $i <= 9; $i++) {
            $client->info("event {$i}");
        }

        self::assertLessThanOrEqual(6, $client->pending());

        $client->flush();
        $sent = array_slice($this->transport->messages(), 2);

        self::assertSame('event 9', $sent[count($sent) - 1]);
        self::assertNotContains('event 1', $sent);
    }

    public function testSplitsALargeBacklogIntoRequestsOfAtMost5000Events(): void
    {
        $client = $this->client(['batchSize' => 5000, 'maxBuffered' => 20_000]);
        $this->transport->willReturn(new Result(503));

        for ($i = 0; $i < 12_000; $i++) {
            $client->info("e{$i}");
        }

        $this->transport->requests = [];
        self::assertTrue($client->flush());

        self::assertSame([5000, 5000, 2000], array_map(
            fn (int $index): int => count($this->transport->events($index)),
            array_keys($this->transport->requests),
        ));
    }

    public function testCloseSendsWhatIsLeftAndIgnoresLaterEvents(): void
    {
        $client = $this->client();

        $client->info('last words');
        $client->close();
        $client->info('after close');
        $client->close();

        self::assertSame(['last words'], $this->transport->messages());
    }

    public function testIsANoOpWithoutAUrlOrToken(): void
    {
        $client = $this->client(['url' => '']);

        $client->error('nobody hears this');
        $client->flush();

        self::assertFalse($client->enabled());
        self::assertSame([], $this->transport->requests);
    }

    public function testReadsItsSettingsFromTheEnvironment(): void
    {
        putenv('KINGLET_URL=https://env.example.com');
        putenv('KINGLET_KEY=kl_env');
        putenv('KINGLET_SERVICE=worker');

        try {
            $client = Client::fromEnvironment([
                'flushOnShutdown' => false,
                'transport' => $this->transport,
            ]);

            $client->info('from env');
            $client->flush();
        } finally {
            putenv('KINGLET_URL');
            putenv('KINGLET_KEY');
            putenv('KINGLET_SERVICE');
        }

        self::assertSame('https://env.example.com/v1/events', $this->transport->requests[0]['url']);
        self::assertSame('kl_env', $this->transport->requests[0]['token']);
        self::assertSame('worker', $this->transport->events()[0]['service']);
    }

    public function testAnErrorHandlerThatThrowsDoesNotReachTheApp(): void
    {
        $client = $this->client(['onError' => static function (): void {
            throw new \LogicException('handler bug');
        }]);
        $this->transport->willReturn(new Result(500));

        $client->info('still fine');

        self::assertFalse($client->flush());
    }

    public function testMapsLevelNamesFromPsr3AndMonolog(): void
    {
        self::assertSame(Level::Info, Level::fromName('notice'));
        self::assertSame(Level::Warn, Level::fromName('WARNING'));
        self::assertSame(Level::Fatal, Level::fromName('emergency'));
        self::assertSame(Level::Info, Level::fromName('verbose'));
    }
}
