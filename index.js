const fs = require("node:fs/promises");
const path = require("node:path");
const http = require("node:http");
const https = require("node:https");
const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const { parse } = require("csv-parse/sync");

const projectRoot = path.resolve(__dirname, process.env.MOST_PROJECT_ROOT || "..");
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config();

const app = express();
const port = Number(process.env.PORT || 4000);

app.use(cors());
app.use(express.json());

const requestsRoot = path.resolve(projectRoot, process.env.REQUESTS_DIR || "requests");
const DEFAULT_RESULTS_SCOPE = "current";

function toPosixRelative(targetPath) {
  return path.relative(projectRoot, targetPath).split(path.sep).join("/");
}

function ensureWithinBase(base, candidate) {
  const resolved = path.resolve(candidate);
  const normalizedBase = path.resolve(base);
  if (resolved === normalizedBase || resolved.startsWith(normalizedBase + path.sep)) {
    return resolved;
  }
  throw new Error("Invalid path.");
}

function safeJoin(base, ...parts) {
  return ensureWithinBase(base, path.join(base, ...parts));
}

async function listDirectories(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

async function listExperimentFolders(basePath) {
  try {
    const names = await listDirectories(basePath);
    return names
      .filter((name) => !name.startsWith(".") && name !== "__pycache__")
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

async function listIterations(experiment, basePath) {
  const experimentPath = safeJoin(basePath, experiment);
  const names = await listDirectories(experimentPath);
  return names.filter((name) => !name.startsWith(".")).sort((a, b) => b.localeCompare(a));
}

async function findLatestIterationFolder(basePath) {
  const experiments = await listExperimentFolders(basePath);
  for (const experiment of [...experiments].sort((a, b) => b.localeCompare(a))) {
    const iterations = await listIterations(experiment, basePath).catch(() => []);
    if (iterations.length > 0) {
      const iteration = iterations[0];
      return {
        experiment,
        iteration,
        path: safeJoin(basePath, experiment, iteration),
      };
    }
  }
  return null;
}

function normalizeResultsScope(rawScope) {
  const normalized = String(rawScope || DEFAULT_RESULTS_SCOPE).trim();
  if (!normalized || normalized.toLowerCase() === DEFAULT_RESULTS_SCOPE) {
    return DEFAULT_RESULTS_SCOPE;
  }

  if (!/^[A-Za-z0-9._-]+$/.test(normalized)) {
    const error = new Error("Invalid results scope.");
    error.code = "INVALID_SCOPE";
    throw error;
  }

  return normalized;
}

async function resolveRequestsBasePath(scope) {
  if (scope === DEFAULT_RESULTS_SCOPE) {
    return requestsRoot;
  }

  const scopedPath = safeJoin(requestsRoot, scope);
  const stat = await fs.stat(scopedPath);
  if (!stat.isDirectory()) {
    const error = new Error("Results scope not found.");
    error.code = "ENOENT";
    throw error;
  }

  return scopedPath;
}

function getResultsScopeFromRequest(req) {
  return normalizeResultsScope(
    req.query.resultsScope || req.query.resultsSet || req.query.round || DEFAULT_RESULTS_SCOPE,
  );
}

async function listResultsScopes() {
  const directoryNames = await listDirectories(requestsRoot).catch(() => []);
  const detectedRoundScopes = directoryNames
    .filter((name) => /^MST[-_]\d+$/i.test(name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));

  return [DEFAULT_RESULTS_SCOPE, ...detectedRoundScopes];
}

function stripQuotes(value) {
  return String(value || "").trim().replace(/^['\"]|['\"]$/g, "");
}

function parseCsvRows(csvText) {
  try {
    return {
      rows: parse(csvText, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        bom: true,
      }),
      relaxed: false,
    };
  } catch {
    // Some exported CSV files contain inconsistent columns or quotes.
    // Retry with tolerant settings so dashboards can still consume most rows.
    return {
      rows: parse(csvText, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        bom: true,
        relax_column_count: true,
        relax_quotes: true,
      }),
      relaxed: true,
    };
  }
}

function inferGpuFromUrl(rawUrl) {
  const cleaned = stripQuotes(rawUrl);
  if (!cleaned) {
    return null;
  }

  let urlToParse = cleaned;
  if (!/^https?:\/\//i.test(urlToParse)) {
    urlToParse = `http://${urlToParse}`;
  }

  try {
    const parsed = new URL(urlToParse);
    const host = parsed.hostname;
    if (!host) {
      return null;
    }
    const firstLabel = host.split(".")[0];
    return firstLabel || host;
  } catch {
    return cleaned;
  }
}

function inferModelFromUrl(rawUrl) {
  const cleaned = stripQuotes(rawUrl);
  if (!cleaned) {
    return null;
  }

  let urlToParse = cleaned;
  if (!/^https?:\/\//i.test(urlToParse)) {
    return null;
  }

  try {
    const parsed = new URL(urlToParse);
    const parts = parsed.pathname
      .split("/")
      .map((part) => part.trim())
      .filter((part) => part && !["v1", "chat", "completions", "generate", "models"].includes(part));
    return parts.length > 0 ? parts[parts.length - 1] : null;
  } catch {
    return null;
  }
}

function normalizeEndpointBaseUrl(rawValue) {
  const cleaned = stripQuotes(rawValue);
  if (!cleaned) {
    return null;
  }

  try {
    const parsed = new URL(cleaned);
    if (parsed.protocol && parsed.host) {
      return `${parsed.protocol}//${parsed.host}`;
    }
  } catch {
    // Ignore and retry by assuming the scheme is missing.
  }

  if (cleaned.includes(" ") || cleaned.startsWith("/")) {
    return null;
  }

  try {
    const parsedWithScheme = new URL(`http://${cleaned}`);
    return `${parsedWithScheme.protocol}//${parsedWithScheme.host}`;
  } catch {
    return null;
  }
}

async function queryModelFromEndpoint(rawEndpoint, timeoutMs = 10000) {
  const baseUrl = normalizeEndpointBaseUrl(rawEndpoint);
  if (!baseUrl) {
    return null;
  }

  let payload;
  try {
    payload = await new Promise((resolve, reject) => {
      const target = new URL("/v1/models", `${baseUrl}/`);
      const transport = target.protocol === "https:" ? https : http;
      const request = transport.request(
        target,
        {
          method: "GET",
          headers: {
            Accept: "application/json",
            "User-Agent": "most-api/1.0",
          },
        },
        (response) => {
          const statusCode = Number(response.statusCode || 0);
          if (statusCode !== 200) {
            response.resume();
            resolve(null);
            return;
          }

          let raw = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => {
            raw += chunk;
          });
          response.on("end", () => {
            try {
              resolve(JSON.parse(raw));
            } catch {
              resolve(null);
            }
          });
        },
      );

      request.setTimeout(timeoutMs, () => {
        request.destroy(new Error("Request timed out"));
      });

      request.on("error", reject);
      request.end();
    });
  } catch {
    return null;
  }

  if (!payload || typeof payload !== "object" || !Array.isArray(payload.data) || payload.data.length === 0) {
    return null;
  }

  const first = payload.data[0];
  if (!first || typeof first !== "object") {
    return null;
  }

  const modelId = first.id;
  if (typeof modelId === "string" && modelId.trim()) {
    return modelId.trim();
  }

  return null;
}

function deepExtractModel(value) {
  if (!value || typeof value !== "object") {
    return null;
  }

  if (!Array.isArray(value)) {
    if (typeof value.model === "string" && value.model.trim()) {
      return value.model.trim();
    }
    if (typeof value.model_name === "string" && value.model_name.trim()) {
      return value.model_name.trim();
    }
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = deepExtractModel(item);
      if (found) {
        return found;
      }
    }
    return null;
  }

  for (const nested of Object.values(value)) {
    const found = deepExtractModel(nested);
    if (found) {
      return found;
    }
  }

  return null;
}

async function tryReadJson(filePath) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function tryReadCsvRecords(filePath) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    return parseCsvRows(text).rows;
  } catch {
    return null;
  }
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

async function resolveLlmName() {
  const timeoutMs = Number(process.env.MODEL_DISCOVERY_TIMEOUT || 10) * 1000;
  const endpointCandidates = [
    process.env.URL,
    process.env.FMPERF_ENDPOINT_URL,
    process.env.ENDPOINT_URL,
  ];

  for (const endpoint of endpointCandidates) {
    const modelFromEndpoint = await queryModelFromEndpoint(endpoint, timeoutMs);
    if (modelFromEndpoint) {
      return {
        llmName: modelFromEndpoint,
        source: "env:/v1/models",
      };
    }
  }

  return { llmName: "unknown", source: "unavailable" };
}

async function resolveGpuUsed(resultsBasePath) {
  const envCandidate = firstNonEmpty(
    process.env.GPU,
    process.env.GPU_USED,
    process.env.GPU_NAME,
    process.env.ACCELERATOR,
  );
  if (envCandidate) {
    return { gpuUsed: envCandidate, source: "env" };
  }

  const latest = await findLatestIterationFolder(resultsBasePath);
  if (latest) {
    const csvRecords = await tryReadCsvRecords(path.join(latest.path, "results.csv"));
    if (csvRecords && csvRecords.length > 0) {
      const row = csvRecords[0];
      const gpuFromCsv = firstNonEmpty(
        row.GPU,
        row.gpu,
        row.GPU_USED,
        row.gpu_used,
        row.HARDWARE,
        row.hardware,
      );
      if (gpuFromCsv) {
        return {
          gpuUsed: gpuFromCsv,
          source: `requests/${latest.experiment}/${latest.iteration}/results.csv`,
        };
      }
    }
  }

  const gpuFromUrl = inferGpuFromUrl(process.env.URL);
  if (gpuFromUrl) {
    return { gpuUsed: gpuFromUrl, source: "env:URL" };
  }

  return { gpuUsed: "unknown", source: "unavailable" };
}

async function requireExistingFile(filePath) {
  await fs.access(filePath);
  return filePath;
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "most-api" });
});

app.get("/api/llm-name", async (_req, res) => {
  const data = await resolveLlmName();
  res.json(data);
});

app.get("/api/gpu-used", async (req, res, next) => {
  try {
    const resultsScope = getResultsScopeFromRequest(req);
    const basePath = await resolveRequestsBasePath(resultsScope);
    const data = await resolveGpuUsed(basePath);
    res.json({
      ...data,
      resultsScope,
      resultsRoot: toPosixRelative(basePath),
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/results-scopes", async (_req, res) => {
  const scopes = await listResultsScopes();
  res.json({
    scopes,
    defaultScope: DEFAULT_RESULTS_SCOPE,
  });
});

app.get("/api/experiments", async (_req, res, next) => {
  try {
    const resultsScope = getResultsScopeFromRequest(_req);
    const basePath = await resolveRequestsBasePath(resultsScope);
    const experiments = await listExperimentFolders(basePath);
    res.json({
      requestsRoot: toPosixRelative(basePath),
      resultsScope,
      experiments,
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/experiments/:experiment/iterations", async (req, res, next) => {
  try {
    const { experiment } = req.params;
    const resultsScope = getResultsScopeFromRequest(req);
    const basePath = await resolveRequestsBasePath(resultsScope);
    const iterations = await listIterations(experiment, basePath);
    res.json({ experiment, iterations, resultsScope });
  } catch (error) {
    next(error);
  }
});

app.get("/api/experiments/:experiment/iterations/:iteration/results.csv", async (req, res, next) => {
  try {
    const { experiment, iteration } = req.params;
    const resultsScope = getResultsScopeFromRequest(req);
    const basePath = await resolveRequestsBasePath(resultsScope);
    const csvPath = await requireExistingFile(
      safeJoin(basePath, experiment, iteration, "results.csv"),
    );
    const csvText = await fs.readFile(csvPath, "utf8");
    let parsed;

    try {
      parsed = parseCsvRows(csvText);
    } catch (parseError) {
      parseError.code = "CSV_PARSE_FAILED";
      parseError.message = "Unable to parse results.csv.";
      throw parseError;
    }

    res.json({
      experiment,
      iteration,
      resultsScope,
      rows: parsed.rows,
      count: parsed.rows.length,
      relaxedParsing: parsed.relaxed,
      source: toPosixRelative(csvPath),
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/experiments/:experiment/iterations/:iteration/download/results.csv", async (req, res, next) => {
  try {
    const { experiment, iteration } = req.params;
    const resultsScope = getResultsScopeFromRequest(req);
    const basePath = await resolveRequestsBasePath(resultsScope);
    const csvPath = await requireExistingFile(
      safeJoin(basePath, experiment, iteration, "results.csv"),
    );
    res.download(csvPath, "results.csv");
  } catch (error) {
    next(error);
  }
});

app.get("/api/experiments/:experiment/iterations/:iteration/download/results.json", async (req, res, next) => {
  try {
    const { experiment, iteration } = req.params;
    const resultsScope = getResultsScopeFromRequest(req);
    const basePath = await resolveRequestsBasePath(resultsScope);
    const jsonPath = await requireExistingFile(
      safeJoin(basePath, experiment, iteration, "results.json"),
    );
    res.download(jsonPath, "results.json");
  } catch (error) {
    next(error);
  }
});

app.use((error, _req, res, _next) => {
  let status = 500;
  let message = "Unexpected server error.";

  if (error && (error.code === "ENOENT" || error.message === "Invalid path.")) {
    status = 404;
    message = "Resource not found.";
  } else if (error && error.code === "INVALID_SCOPE") {
    status = 400;
    message = "Invalid results scope.";
  } else if (error && error.code === "CSV_PARSE_FAILED") {
    status = 422;
    message = "The CSV file exists but could not be parsed.";
  }

  res.status(status).json({ error: message });
});

app.listen(port, () => {
  console.log(`MoST API listening on http://localhost:${port}`);
  console.log(`Reading experiments from: ${requestsRoot}`);
});
