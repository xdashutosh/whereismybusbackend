// Express request augmentation shared by every middleware. requestId sets `id`; the request
// logger `log` comes from pino-http's own IncomingMessage augmentation.
import 'pino-http';

declare module 'express-serve-static-core' {
  interface Request {
    /** Request id (middleware/requestId). */
    id: string;
  }
}
