declare const request: { headers: Record<string, string> };

const token = process.env.API_TOKEN;
if (!token) {
  throw new Error("API_TOKEN is required");
}

request.headers.Authorization = `Bearer ${token}`;
request.headers["x-request-id"] = `checkly-${Date.now()}`;
