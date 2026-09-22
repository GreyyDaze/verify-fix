// HAR 1.2 subset used by the bundle (what Playwright records in a trace).

export interface HarHeader {
  name: string;
  value: string;
}

export interface HarPostData {
  mimeType: string;
  text?: string;
  params?: Array<{ name: string; value?: string }>;
  comment?: string;
  /** Playwright-internal pointers to the body blob; resolved and removed by the converter. */
  _sha1?: string;
  /** "resources/<sha1>.<ext>" in traces from Playwright 1.5x+ */
  _file?: string;
}

export interface HarContent {
  size: number;
  mimeType: string;
  text?: string;
  encoding?: "base64";
  compression?: number;
  comment?: string;
  _sha1?: string;
  _file?: string;
}

export interface HarEntry {
  pageref?: string;
  startedDateTime: string;
  time: number;
  request: {
    method: string;
    url: string;
    httpVersion: string;
    cookies: Array<{ name: string; value: string }>;
    headers: HarHeader[];
    queryString: Array<{ name: string; value: string }>;
    headersSize: number;
    bodySize: number;
    postData?: HarPostData;
  };
  response: {
    status: number;
    statusText: string;
    httpVersion: string;
    cookies: Array<{ name: string; value: string }>;
    headers: HarHeader[];
    content: HarContent;
    headersSize: number;
    bodySize: number;
    redirectURL: string;
    _transferSize?: number;
    _failureText?: string;
  };
  cache: Record<string, unknown>;
  timings: Record<string, number>;
  serverIPAddress?: string;
  _resourceType?: string;
  _monotonicTime?: number;
  _frameref?: string;
  _serviceWorkerRef?: string;
  _securityDetails?: unknown;
  _serverPort?: number;
}

export interface Har {
  log: {
    version: "1.2";
    creator: { name: string; version: string; comment?: string };
    pages: Array<{ id: string; startedDateTime: string; title: string; pageTimings: Record<string, number> }>;
    entries: HarEntry[];
  };
}
