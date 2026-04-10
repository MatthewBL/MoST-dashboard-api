const fs = require("node:fs/promises");
const path = require("node:path");
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

async function listExperimentFolders() {
  try {
    const names = await listDirectories(requestsRoot);
    return names
      .filter((name) => !name.startsWith(".") && name !== "__pycache__")
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

async function listIterations(experiment) {
  const experimentPath = safeJoin(requestsRoot, experiment);
  const names = await listDirectories(experimentPath);
  return names.filter((name) => !name.startsWith(".")).sort((a, b) => b.localeCompare(a));
}

async function findLatestIterationFolder() {
  const experiments = await listExperimentFolders();
  for (const experiment of [...experiments].sort((a, b) => b.localeCompare(a))) {
    const iterations = await listIterations(experiment).catch(() => []);
    if (iterations.length > 0) {
      const iteration = iterations[0];
      return {
        experiment,
        iteration,
        path: safeJoin(requestsRoot, experiment, iteration),
      };
    }
  }
  return null;
}

function stripQuotes(value) {
  return String(value || "").trim().replace(/^['\"]|['\"]$/g, "");
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
    return parse(text, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    });
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
  const envCandidate = firstNonEmpty(
    process.env.LLM_NAME,
    process.env.MODEL_NAME,
    process.env.MODEL,
    process.env.FMPERF_MODEL,
  );
  if (envCandidate) {
    return { llmName: envCandidate, source: "env" };
  }

  const latest = await findLatestIterationFolder();
  if (latest) {
    const jsonData = await tryReadJson(path.join(latest.path, "results.json"));
    const modelFromJson = deepExtractModel(jsonData);
    if (modelFromJson) {
      return {
        llmName: modelFromJson,
        source: `requests/${latest.experiment}/${latest.iteration}/results.json`,
      };
    }

    const csvRecords = await tryReadCsvRecords(path.join(latest.path, "results.csv"));
    if (csvRecords && csvRecords.length > 0) {
      const row = csvRecords[0];
      const modelFromCsv = firstNonEmpty(
        row.MODEL,
        row.model,
        row.MODEL_NAME,
        row.model_name,
        row.LLM,
        row.llm,
      );
      if (modelFromCsv) {
        return {
          llmName: modelFromCsv,
          source: `requests/${latest.experiment}/${latest.iteration}/results.csv`,
        };
      }
    }
  }

  const modelFromUrl = inferModelFromUrl(process.env.URL);
  if (modelFromUrl) {
    return { llmName: modelFromUrl, source: "env:URL" };
  }

  return { llmName: "unknown", source: "unavailable" };
}

async function resolveGpuUsed() {
  const envCandidate = firstNonEmpty(
    process.env.GPU,
    process.env.GPU_USED,
    process.env.GPU_NAME,
    process.env.ACCELERATOR,
  );
  if (envCandidate) {
    return { gpuUsed: envCandidate, source: "env" };
  }

  const latest = await findLatestIterationFolder();
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

app.get("/api/gpu-used", async (_req, res) => {
  const data = await resolveGpuUsed();
  res.json(data);
});

app.get("/api/experiments", async (_req, res, next) => {
  try {
    const experiments = await listExperimentFolders();
    res.json({
      requestsRoot: toPosixRelative(requestsRoot),
      experiments,
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/experiments/:experiment/iterations", async (req, res, next) => {
  try {
    const { experiment } = req.params;
    const iterations = await listIterations(experiment);
    res.json({ experiment, iterations });
  } catch (error) {
    next(error);
  }
});

app.get("/api/experiments/:experiment/iterations/:iteration/results.csv", async (req, res, next) => {
  try {
    const { experiment, iteration } = req.params;
    const csvPath = await requireExistingFile(
      safeJoin(requestsRoot, experiment, iteration, "results.csv"),
    );
    const csvText = await fs.readFile(csvPath, "utf8");
    const records = parse(csvText, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    });

    res.json({
      experiment,
      iteration,
      rows: records,
      count: records.length,
      source: toPosixRelative(csvPath),
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/experiments/:experiment/iterations/:iteration/download/results.csv", async (req, res, next) => {
  try {
    const { experiment, iteration } = req.params;
    const csvPath = await requireExistingFile(
      safeJoin(requestsRoot, experiment, iteration, "results.csv"),
    );
    res.download(csvPath, "results.csv");
  } catch (error) {
    next(error);
  }
});

app.get("/api/experiments/:experiment/iterations/:iteration/download/results.json", async (req, res, next) => {
  try {
    const { experiment, iteration } = req.params;
    const jsonPath = await requireExistingFile(
      safeJoin(requestsRoot, experiment, iteration, "results.json"),
    );
    res.download(jsonPath, "results.json");
  } catch (error) {
    next(error);
  }
});

app.use((error, _req, res, _next) => {
  const status = error && (error.code === "ENOENT" || error.message === "Invalid path.") ? 404 : 500;
  const message = status === 404 ? "Resource not found." : "Unexpected server error.";
  res.status(status).json({ error: message });
});

app.listen(port, () => {
  console.log(`MoST API listening on http://localhost:${port}`);
  console.log(`Reading experiments from: ${requestsRoot}`);
});
