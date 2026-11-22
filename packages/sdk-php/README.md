# rushlightlab/kinglet

Batching log client for [Kinglet](https://kinglet.rushlightlab.com), the tiny
self-hostable log platform. Plain PHP, PSR-3, and Monolog (Laravel, Symfony).

- **No required dependencies.** PHP 8.1+ and ext-json; uses ext-curl when loaded,
  PHP streams otherwise.
- **Never breaks your app.** Logging calls don't throw, requests time out after
  2 s, and an unreachable Kinglet backs off instead of slowing every request.
- **Batched.** Events are sent in one request when the batch fills, every few
  seconds in long-running workers, and when the script ends.

```bash
composer require rushlightlab/kinglet
```

## Quick start

```php
use Kinglet\Client;

$kinglet = new Client(
    url: 'https://logs.example.com',
    token: 'kl_...',          // a project API key with the ingest scope
    service: 'checkout',
    env: 'prod',
);

$kinglet->info('order placed', ['orderId' => 'A-42', 'amount' => 19.5]);
$kinglet->error('payment failed', ['exception' => $e]);
```

Or configure it from the environment (`KINGLET_URL`, `KINGLET_KEY`, and
optionally `KINGLET_SERVICE`, `KINGLET_ENV`):

```php
$kinglet = Client::fromEnvironment();
```

Fields are searchable in Kinglet with [Trill](https://kinglet.rushlightlab.com/trill/):
`field.orderId:A-42`, `field.amount>10`, `field.exception.class:RuntimeException`.

## Laravel

Add a channel in `config/logging.php`:

```php
'kinglet' => [
    'driver' => 'monolog',
    'handler' => Kinglet\Monolog\KingletHandler::class,
    'handler_with' => [
        'url' => env('KINGLET_URL'),
        'token' => env('KINGLET_KEY'),
        'service' => env('KINGLET_SERVICE', 'laravel'),
        'env' => env('APP_ENV'),
    ],
    'level' => env('LOG_LEVEL', 'debug'),
],
```

Then log to it, or add it to your `stack` channel:

```php
Log::channel('kinglet')->info('order placed', ['orderId' => 'A-42']);
```

## Symfony

Register the handler as a service and point Monolog at it:

```yaml
# config/services.yaml
services:
  Kinglet\Monolog\KingletHandler:
    arguments:
      $url: "%env(KINGLET_URL)%"
      $token: "%env(KINGLET_KEY)%"
      $service: "symfony"
      $env: "%kernel.environment%"

# config/packages/monolog.yaml
monolog:
  handlers:
    kinglet:
      type: service
      id: Kinglet\Monolog\KingletHandler
```

## PSR-3

```php
use Kinglet\Client;
use Kinglet\Psr\KingletLogger;

$logger = new KingletLogger(Client::fromEnvironment());
$logger->warning('Payment {id} retried', ['id' => 'pay_42', 'attempt' => 2]);
```

## Options

| Option            | Default | What it does                                                                          |
| ----------------- | ------- | ------------------------------------------------------------------------------------- |
| `url`, `token`    | —       | Kinglet base URL and API key; leave either empty to disable                           |
| `service`, `env`  | `null`  | Tag every event                                                                       |
| `batchSize`       | `100`   | Send when this many events are buffered (max 5000)                                    |
| `flushInterval`   | `5.0`   | Also send when this many seconds passed, checked on each log call                     |
| `maxBuffered`     | `10000` | Most events kept while Kinglet is unreachable (oldest dropped)                        |
| `timeout`         | `2.0`   | Seconds one request may take                                                          |
| `flushOnShutdown` | `true`  | Send what's left when the script ends                                                 |
| `onError`         | `null`  | `fn (KingletException $e)` for failed batches; otherwise a throttled `error_log` line |

Long-running processes (queue workers, Octane, daemons) can call
`$kinglet->flush()` between jobs. Call `$kinglet->close()` to send what's left
and stop.

## License

MIT
