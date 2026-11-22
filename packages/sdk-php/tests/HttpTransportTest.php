<?php

declare(strict_types=1);

namespace Kinglet\Tests;

use Kinglet\Client;
use Kinglet\Transport\HttpTransport;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/**
 * Runs the real HTTP transport, over curl and over PHP streams, against a
 * local `php -S` server that stands in for Kinglet's ingest endpoint.
 */
final class HttpTransportTest extends TestCase
{
    /** @var resource|null */
    private static $server = null;

    private static string $base = '';

    private static string $log = '';

    public static function setUpBeforeClass(): void
    {
        $port = self::freePort();
        self::$base = "http://127.0.0.1:{$port}";
        self::$log = sys_get_temp_dir() . '/kinglet-sdk-php-' . getmypid() . '.log';
        @unlink(self::$log);

        $command = [PHP_BINARY, '-S', "127.0.0.1:{$port}", __DIR__ . '/fixtures/server.php'];
        $env = [...getenv(), 'KINGLET_TEST_LOG' => self::$log];
        $null = PHP_OS_FAMILY === 'Windows' ? 'NUL' : '/dev/null';
        $process = proc_open($command, [1 => ['file', $null, 'w'], 2 => ['file', $null, 'w']], $pipes, null, $env);

        self::assertIsResource($process);
        self::$server = $process;

        for ($i = 0; $i < 100; $i++) {
            $socket = @fsockopen('127.0.0.1', $port, $code, $message, 0.1);

            if ($socket !== false) {
                fclose($socket);

                return;
            }

            usleep(50_000);
        }

        self::fail('the test server did not start');
    }

    public static function tearDownAfterClass(): void
    {
        if (self::$server !== null) {
            proc_terminate(self::$server);
            proc_close(self::$server);
            self::$server = null;
        }

        @unlink(self::$log);
    }

    protected function setUp(): void
    {
        file_put_contents(self::$log, '');
    }

    private static function freePort(): int
    {
        $socket = stream_socket_server('tcp://127.0.0.1:0');
        self::assertNotFalse($socket);
        $name = (string) stream_socket_get_name($socket, false);
        fclose($socket);

        return (int) substr($name, (int) strrpos($name, ':') + 1);
    }

    /** @return list<array<string, string>> */
    private static function requests(): array
    {
        $lines = array_filter(explode("\n", (string) file_get_contents(self::$log)));

        return array_values(array_map(
            static fn (string $line): array => json_decode($line, true, 512, JSON_THROW_ON_ERROR),
            $lines,
        ));
    }

    /** @return array<string, array{bool}> */
    public static function transports(): array
    {
        return ['curl' => [true], 'streams' => [false]];
    }

    #[DataProvider('transports')]
    public function testPostsAnNdjsonBatchWithTheKey(bool $useCurl): void
    {
        if ($useCurl && !function_exists('curl_init')) {
            self::markTestSkipped('ext-curl is not loaded');
        }

        $result = (new HttpTransport($useCurl))->send(self::$base . '/v1/events', 'kl_secret', "{\"a\":1}\n{\"b\":2}", 2.0);

        [$request] = self::requests();

        self::assertSame(200, $result->status);
        self::assertTrue($result->ok());
        self::assertSame('POST', $request['method']);
        self::assertSame('/v1/events', $request['path']);
        self::assertSame('Bearer kl_secret', $request['authorization']);
        self::assertSame('application/x-ndjson', $request['contentType']);
        self::assertStringStartsWith('kinglet-sdk-php/', $request['userAgent']);
        self::assertSame("{\"a\":1}\n{\"b\":2}", $request['body']);
    }

    #[DataProvider('transports')]
    public function testReportsTheServersErrorStatusAndBody(bool $useCurl): void
    {
        if ($useCurl && !function_exists('curl_init')) {
            self::markTestSkipped('ext-curl is not loaded');
        }

        $result = (new HttpTransport($useCurl))->send(self::$base . '/unauthorized', 'kl_bad', '{}', 2.0);

        self::assertSame(401, $result->status);
        self::assertFalse($result->retryable());
        self::assertStringContainsString('invalid key', $result->body);
    }

    #[DataProvider('transports')]
    public function testGivesUpAtTheTimeoutWithoutThrowing(bool $useCurl): void
    {
        if ($useCurl && !function_exists('curl_init')) {
            self::markTestSkipped('ext-curl is not loaded');
        }

        $started = microtime(true);
        $result = (new HttpTransport($useCurl))->send(self::$base . '/slow', 'kl_test', '{}', 0.3);

        self::assertNull($result->status);
        self::assertTrue($result->retryable());
        self::assertLessThan(1.4, microtime(true) - $started);
    }

    #[DataProvider('transports')]
    public function testReportsAnUnreachableServerWithoutThrowing(bool $useCurl): void
    {
        if ($useCurl && !function_exists('curl_init')) {
            self::markTestSkipped('ext-curl is not loaded');
        }

        $result = (new HttpTransport($useCurl))->send('http://127.0.0.1:' . self::freePort() . '/v1/events', 'kl_test', '{}', 1.0);

        self::assertNull($result->status);
        self::assertNotNull($result->error);
    }

    public function testClientDeliversThroughTheRealTransport(): void
    {
        $client = new Client(url: self::$base, token: 'kl_live', service: 'php', flushOnShutdown: false);

        $client->info('over the wire', ['n' => 1]);
        self::assertTrue($client->flush());

        [$request] = self::requests();
        $event = json_decode($request['body'], true, 512, JSON_THROW_ON_ERROR);

        self::assertSame('over the wire', $event['message']);
        self::assertSame('php', $event['service']);
        self::assertSame(['n' => 1], $event['fields']);
    }
}
