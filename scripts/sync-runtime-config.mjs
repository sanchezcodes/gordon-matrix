#!/usr/bin/env node

import fs from "node:fs";

/**
 * Synchronize runtime env decisions into config on startup.
 *
 * Design goals:
 * - idempotent: re-running should converge to the same config state
 * - additive: only set/normalize fields owned by this template
 * - low surprise: avoid overriding explicit user choices unless they no longer fit available providers
 */
const truthyValues = new Set(["1", "true", "yes", "on"]);

function trimValue(value) {
  return String(value ?? "").trim();
}

function readConfig(configPath) {
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (error) {
    console.error(`Failed to read or parse config at ${configPath}: ${error}`);
    process.exit(1);
  }
}

function ensureObject(target, key) {
  if (typeof target[key] !== "object" || target[key] === null || Array.isArray(target[key])) {
    target[key] = {};
  }
  return target[key];
}

function ensureArray(target, key) {
  if (!Array.isArray(target[key])) {
    target[key] = [];
  }
  return target[key];
}

function providerFromModel(model) {
  const normalizedModel = trimValue(model);
  if (!normalizedModel.includes("/")) {
    return "";
  }
  return normalizedModel.slice(0, normalizedModel.indexOf("/"));
}

function toUniqueStrings(values) {
  const unique = [];
  const seen = new Set();
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }
    const normalized = trimValue(value);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    unique.push(normalized);
  }
  return unique;
}

function arraysEqual(left, right) {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

function parseCsvList(value) {
  if (!value) {
    return [];
  }
  return toUniqueStrings(
    value
      .split(",")
      .map((entry) => trimValue(entry))
      .filter(Boolean),
  );
}

// Order matters: first available provider becomes default primary model when current primary is missing/unusable.
const providerDefaults = [
  {
    provider: "openai",
    envVar: "OPENAI_API_KEY",
    profileKey: "openai:default",
    primaryModel: "openai/gpt-5.2",
    fallbackModels: ["openai/gpt-4o"],
  },
  {
    provider: "anthropic",
    envVar: "ANTHROPIC_API_KEY",
    profileKey: "anthropic:default",
    primaryModel: "anthropic/claude-opus-4-5",
    fallbackModels: ["anthropic/claude-sonnet-4-5"],
  },
  {
    provider: "google",
    envVar: "GEMINI_API_KEY",
    profileKey: "google:default",
    primaryModel: "google/gemini-3-pro-preview",
    fallbackModels: [],
  },
];
const providerDefaultsByName = new Map(providerDefaults.map((entry) => [entry.provider, entry]));

const configPath = trimValue(process.env.OPENCLAW_CONFIG_FILE);
if (!configPath) {
  console.error("OPENCLAW_CONFIG_FILE is required.");
  process.exit(1);
}
if (!fs.existsSync(configPath)) {
  console.error(`Config file not found at ${configPath}; skipping runtime sync.`);
  process.exit(0);
}

const config = readConfig(configPath);
let changed = false;

const stateDir = trimValue(process.env.OPENCLAW_STATE_DIR) || "/data";
const desiredWorkspace = trimValue(process.env.OPENCLAW_WORKSPACE_DIR) || `${stateDir}/workspace`;
const agents = ensureObject(config, "agents");
const defaults = ensureObject(agents, "defaults");
const agentList = ensureArray(agents, "list");
if (defaults.workspace !== desiredWorkspace) {
  defaults.workspace = desiredWorkspace;
  console.log(`Set agents.defaults.workspace=${desiredWorkspace}`);
  changed = true;
}

// Force sandbox.mode to "off" — Docker socket is not available inside the container,
// so any other value (including the invalid "none" from earlier deploys) causes
// "spawn docker EACCES" errors at runtime.
const sandbox = ensureObject(defaults, "sandbox");
if (sandbox.mode !== "off") {
  const previous = sandbox.mode;
  sandbox.mode = "off";
  console.log(`Set agents.defaults.sandbox.mode=off (was ${JSON.stringify(previous)})`);
  changed = true;
}

const hasMainAgent = agentList.some(
  (agent) => agent && typeof agent === "object" && trimValue(agent.id) === "main",
);
if (!hasMainAgent) {
  agentList.push({
    id: "main",
    default: true,
  });
  console.log("Added agents.list entry for main");
  changed = true;
}

const hasHooksAgent = agentList.some(
  (agent) => agent && typeof agent === "object" && trimValue(agent.id) === "hooks",
);
if (!hasHooksAgent) {
  agentList.push({
    id: "hooks",
  });
  console.log("Added agents.list entry for hooks");
  changed = true;
}

if (Object.prototype.hasOwnProperty.call(process.env, "OPENCLAW_CONTROL_UI_ALLOW_INSECURE_AUTH")) {
  const desiredAllowInsecureAuth = truthyValues.has(
    trimValue(process.env.OPENCLAW_CONTROL_UI_ALLOW_INSECURE_AUTH).toLowerCase(),
  );
  const gateway = ensureObject(config, "gateway");
  const controlUi = ensureObject(gateway, "controlUi");
  if (controlUi.allowInsecureAuth !== desiredAllowInsecureAuth) {
    controlUi.allowInsecureAuth = desiredAllowInsecureAuth;
    console.log(`Set gateway.controlUi.allowInsecureAuth=${desiredAllowInsecureAuth}`);
    changed = true;
  }
}

const hooksToken = trimValue(process.env.OPENCLAW_HOOKS_TOKEN);
const hooksPathEnv = trimValue(process.env.OPENCLAW_HOOKS_PATH);
const hooksAllowedAgentIdsEnv = Object.prototype.hasOwnProperty.call(
  process.env,
  "OPENCLAW_HOOKS_ALLOWED_AGENT_IDS",
)
  ? trimValue(process.env.OPENCLAW_HOOKS_ALLOWED_AGENT_IDS)
  : null;
const gatewayForHooksMigration = ensureObject(config, "gateway");
const legacyGatewayHooks =
  gatewayForHooksMigration.hooks &&
  typeof gatewayForHooksMigration.hooks === "object" &&
  !Array.isArray(gatewayForHooksMigration.hooks)
    ? gatewayForHooksMigration.hooks
    : null;
const hooks = ensureObject(config, "hooks");
if (legacyGatewayHooks) {
  if (
    (typeof hooks.enabled !== "boolean" && typeof legacyGatewayHooks.enabled === "boolean") ||
    (typeof hooks.path !== "string" && typeof legacyGatewayHooks.path === "string") ||
    (!Array.isArray(hooks.allowedAgentIds) && Array.isArray(legacyGatewayHooks.allowedAgentIds))
  ) {
    if (typeof hooks.enabled !== "boolean" && typeof legacyGatewayHooks.enabled === "boolean") {
      hooks.enabled = legacyGatewayHooks.enabled;
    }
    if (typeof hooks.path !== "string" && typeof legacyGatewayHooks.path === "string") {
      hooks.path = legacyGatewayHooks.path;
    }
    if (!Array.isArray(hooks.allowedAgentIds) && Array.isArray(legacyGatewayHooks.allowedAgentIds)) {
      hooks.allowedAgentIds = legacyGatewayHooks.allowedAgentIds;
    }
  }
  delete gatewayForHooksMigration.hooks;
  console.log("Moved legacy gateway.hooks to top-level hooks");
  changed = true;
}

const desiredHooksPath = hooksPathEnv || "/hooks";
if (hooks.path !== desiredHooksPath) {
  hooks.path = desiredHooksPath;
  console.log(`Set hooks.path=${desiredHooksPath}`);
  changed = true;
}

if (hooksToken) {
  if (hooks.enabled !== true) {
    hooks.enabled = true;
    console.log("Set hooks.enabled=true");
    changed = true;
  }
  if (hooks.token !== hooksToken) {
    hooks.token = hooksToken;
    console.log("Set hooks.token from OPENCLAW_HOOKS_TOKEN");
    changed = true;
  }
} else if (hooks.enabled === true && !trimValue(hooks.token)) {
  // Keep webhook config safe-by-default if enabled without a token.
  hooks.enabled = false;
  console.log("Set hooks.enabled=false (missing token)");
  changed = true;
}

if (hooksAllowedAgentIdsEnv !== null) {
  const desiredAllowedAgentIds =
    hooksAllowedAgentIdsEnv === ""
      ? []
      : parseCsvList(hooksAllowedAgentIdsEnv);
  const currentAllowedAgentIds = Array.isArray(hooks.allowedAgentIds) ? hooks.allowedAgentIds : [];
  if (!arraysEqual(currentAllowedAgentIds, desiredAllowedAgentIds)) {
    hooks.allowedAgentIds = desiredAllowedAgentIds;
    console.log(`Set hooks.allowedAgentIds=${JSON.stringify(desiredAllowedAgentIds)}`);
    changed = true;
  }
} else if (!Array.isArray(hooks.allowedAgentIds)) {
  hooks.allowedAgentIds = ["*"];
  console.log('Set hooks.allowedAgentIds=["*"]');
  changed = true;
}

const auth = ensureObject(config, "auth");
const authProfiles = ensureObject(auth, "profiles");
const availableProviders = [];
for (const providerConfig of providerDefaults) {
  if (!trimValue(process.env[providerConfig.envVar])) {
    continue;
  }
  availableProviders.push(providerConfig.provider);
  const existingProfile = authProfiles[providerConfig.profileKey];
  if (
    !existingProfile ||
    typeof existingProfile !== "object" ||
    Array.isArray(existingProfile) ||
    existingProfile.mode !== "token" ||
    existingProfile.provider !== providerConfig.provider
  ) {
    authProfiles[providerConfig.profileKey] = {
      mode: "token",
      provider: providerConfig.provider,
    };
    console.log(`Set auth.profiles.${providerConfig.profileKey} from ${providerConfig.envVar}`);
    changed = true;
  }
}

if (availableProviders.length > 0) {
  const modelDefaults = ensureObject(config.agents.defaults, "model");
  if (typeof modelDefaults.primary !== "string") {
    modelDefaults.primary = "";
  }
  const currentPrimary = trimValue(modelDefaults.primary);
  const currentPrimaryProvider = providerFromModel(currentPrimary);

  let primaryModelUpdated = false;
  // Preserve explicit primary choices when still supported by available provider keys.
  // Only reset when primary is absent or points to a provider with no key in this deployment.
  if (!currentPrimary || !availableProviders.includes(currentPrimaryProvider)) {
    const preferredProvider = availableProviders[0];
    const preferredProviderDefaults = providerDefaultsByName.get(preferredProvider);
    if (preferredProviderDefaults && modelDefaults.primary !== preferredProviderDefaults.primaryModel) {
      modelDefaults.primary = preferredProviderDefaults.primaryModel;
      primaryModelUpdated = true;
      changed = true;
      console.log(`Set agents.defaults.model.primary=${preferredProviderDefaults.primaryModel}`);
    }
  }

  const activePrimaryProvider = providerFromModel(modelDefaults.primary);
  const recommendedFallbacks = toUniqueStrings(
    availableProviders
      .filter((provider) => provider !== activePrimaryProvider)
      .flatMap((provider) => {
        const providerConfig = providerDefaultsByName.get(provider);
        if (!providerConfig) {
          return [];
        }
        return [providerConfig.primaryModel, ...providerConfig.fallbackModels];
      })
      .filter((model) => providerFromModel(model) && providerFromModel(model) !== activePrimaryProvider),
  );

  const existingFallbacks = Array.isArray(modelDefaults.fallbacks) ? modelDefaults.fallbacks : [];
  const filteredExistingFallbacks = toUniqueStrings(
    existingFallbacks.filter((model) => {
      const provider = providerFromModel(model);
      return provider && availableProviders.includes(provider) && model !== modelDefaults.primary;
    }),
  );

  const fallbackProviders = new Set(
    filteredExistingFallbacks.map((model) => providerFromModel(model)).filter(Boolean),
  );
  const missingFallbackProviders = availableProviders.filter(
    (provider) => provider !== activePrimaryProvider && !fallbackProviders.has(provider),
  );
  const missingRecommendedFallbacks =
    missingFallbackProviders.length === 0
      ? []
      : recommendedFallbacks.filter((model) =>
          missingFallbackProviders.includes(providerFromModel(model)),
        );
  const mergedFallbacks =
    missingRecommendedFallbacks.length > 0
      ? toUniqueStrings([...filteredExistingFallbacks, ...missingRecommendedFallbacks])
      : filteredExistingFallbacks;

  const desiredFallbacks =
    // When we just changed primary (or no usable fallbacks exist), rebuild fallbacks from active providers.
    // Otherwise preserve the operator's existing, valid fallback ordering.
    primaryModelUpdated || filteredExistingFallbacks.length === 0
      ? recommendedFallbacks
      : mergedFallbacks;

  if (!arraysEqual(existingFallbacks, desiredFallbacks)) {
    modelDefaults.fallbacks = desiredFallbacks;
    changed = true;
    console.log(`Set agents.defaults.model.fallbacks=${JSON.stringify(desiredFallbacks)}`);
  }
}

const discordBotToken = trimValue(process.env.DISCORD_BOT_TOKEN);
const discordGuildId = trimValue(process.env.DISCORD_GUILD_ID);
const discordChannelId = trimValue(process.env.DISCORD_CHANNEL_ID);
if (discordBotToken && discordGuildId) {
  // Zero-touch Discord bootstrapping:
  // token + guild id are enough for a working default integration.
  const plugins = ensureObject(config, "plugins");
  const pluginEntries = ensureObject(plugins, "entries");
  const discordPlugin = ensureObject(pluginEntries, "discord");
  if (discordPlugin.enabled !== true) {
    discordPlugin.enabled = true;
    console.log("Set plugins.entries.discord.enabled=true");
    changed = true;
  }

  const bindings = ensureArray(config, "bindings");
  const hasDiscordBinding = bindings.some(
    (binding) =>
      binding &&
      typeof binding === "object" &&
      binding.agentId === "main" &&
      binding.match &&
      typeof binding.match === "object" &&
      binding.match.channel === "discord",
  );
  if (!hasDiscordBinding) {
    bindings.push({
      agentId: "main",
      match: {
        channel: "discord",
      },
    });
    console.log("Added default Discord binding for agent main");
    changed = true;
  }

  const channels = ensureObject(config, "channels");
  const discordChannel = ensureObject(channels, "discord");
  if (discordChannel.enabled !== true) {
    discordChannel.enabled = true;
    console.log("Set channels.discord.enabled=true");
    changed = true;
  }
  if (discordChannel.groupPolicy !== "open") {
    // Requested template default: permit chat in any guild channel out of the box.
    discordChannel.groupPolicy = "open";
    console.log("Set channels.discord.groupPolicy=open");
    changed = true;
  }

  const guilds = ensureObject(discordChannel, "guilds");
  const guildConfig = ensureObject(guilds, discordGuildId);
  if (guildConfig.requireMention !== false) {
    guildConfig.requireMention = false;
    console.log(`Set channels.discord.guilds.${discordGuildId}.requireMention=false`);
    changed = true;
  }

  const guildChannels = ensureObject(guildConfig, "channels");
  const defaultChannelKey = discordChannelId || "general";

  const wildcardChannel = ensureObject(guildChannels, "*");
  if (wildcardChannel.allow !== true) {
    // Wildcard entry keeps "any channel" behavior even when explicit channels are present.
    wildcardChannel.allow = true;
    console.log(`Set channels.discord.guilds.${discordGuildId}.channels.*.allow=true`);
    changed = true;
  }
  if (wildcardChannel.requireMention !== false) {
    wildcardChannel.requireMention = false;
    console.log(`Set channels.discord.guilds.${discordGuildId}.channels.*.requireMention=false`);
    changed = true;
  }

  const defaultChannel = ensureObject(guildChannels, defaultChannelKey);
  if (defaultChannel.allow !== true) {
    // Seed one explicit channel key for clarity/discoverability in config and UI.
    defaultChannel.allow = true;
    console.log(`Set channels.discord.guilds.${discordGuildId}.channels.${defaultChannelKey}.allow=true`);
    changed = true;
  }
  if (defaultChannel.requireMention !== false) {
    defaultChannel.requireMention = false;
    console.log(
      `Set channels.discord.guilds.${discordGuildId}.channels.${defaultChannelKey}.requireMention=false`,
    );
    changed = true;
  }
} else if (discordBotToken || discordGuildId) {
  // Keep this non-fatal so deployment succeeds while workflow warnings call out the missing pair.
  console.log("Skipping Discord auto-wiring: set both DISCORD_BOT_TOKEN and DISCORD_GUILD_ID.");
}

const telegramBotToken = trimValue(process.env.TELEGRAM_BOT_TOKEN);
if (telegramBotToken) {
  // Zero-touch Telegram bootstrapping:
  // bot token alone is enough for a working default integration.
  // The gateway's plugin-auto-enable treats Telegram as a plugin and creates
  // plugins.entries.telegram.enabled=false if the entry is missing. Force it to
  // true so auto-enable sees it's already enabled and leaves it alone (same
  // pattern as Discord on line 365).
  const pluginsForTelegram = ensureObject(config, "plugins");
  const pluginEntriesForTelegram = ensureObject(pluginsForTelegram, "entries");
  const telegramPlugin = ensureObject(pluginEntriesForTelegram, "telegram");
  if (telegramPlugin.enabled !== true) {
    telegramPlugin.enabled = true;
    console.log("Set plugins.entries.telegram.enabled=true");
    changed = true;
  }

  const bindings = ensureArray(config, "bindings");
  const hasTelegramBinding = bindings.some(
    (binding) =>
      binding &&
      typeof binding === "object" &&
      binding.agentId === "main" &&
      binding.match &&
      typeof binding.match === "object" &&
      binding.match.channel === "telegram",
  );
  if (!hasTelegramBinding) {
    bindings.push({
      agentId: "main",
      match: {
        channel: "telegram",
      },
    });
    console.log("Added default Telegram binding for agent main");
    changed = true;
  }

  const channels = ensureObject(config, "channels");
  const telegramChannel = ensureObject(channels, "telegram");
  if (telegramChannel.enabled !== true) {
    telegramChannel.enabled = true;
    console.log("Set channels.telegram.enabled=true");
    changed = true;
  }
  if (telegramChannel.dmPolicy !== "pairing") {
    // Requested template default: require pairing before DM works.
    telegramChannel.dmPolicy = "pairing";
    console.log("Set channels.telegram.dmPolicy=pairing");
    changed = true;
  }
  if (telegramChannel.groupPolicy !== "open") {
    // Requested template default: permit groups without allowlist out of the box.
    telegramChannel.groupPolicy = "open";
    console.log("Set channels.telegram.groupPolicy=open");
    changed = true;
  }

  const groups = ensureObject(telegramChannel, "groups");
  const wildcardGroup = ensureObject(groups, "*");
  if (wildcardGroup.requireMention !== false) {
    wildcardGroup.requireMention = false;
    console.log("Set channels.telegram.groups.*.requireMention=false");
    changed = true;
  }
} else {
  // Token absent or empty — disable Telegram channel if it was previously auto-wired.
  const channels = config.channels;
  if (channels && channels.telegram && channels.telegram.enabled === true) {
    channels.telegram.enabled = false;
    console.log("Set channels.telegram.enabled=false (token removed)");
    changed = true;
  }
  // Clean up stale plugin entry unconditionally.
  const plugins = config.plugins;
  if (plugins && plugins.entries && Object.prototype.hasOwnProperty.call(plugins.entries, "telegram")) {
    delete plugins.entries.telegram;
    console.log("Removed stale plugins.entries.telegram");
    changed = true;
  }
  if (Object.prototype.hasOwnProperty.call(process.env, "TELEGRAM_BOT_TOKEN")) {
    console.log("Skipping Telegram auto-wiring: TELEGRAM_BOT_TOKEN is set but empty.");
  }
}

// Remove plugins.allow entirely from persisted configs (gateway bug #2073 treats
// built-in channels as plugins; any allowlist — empty or not — activates filtering
// and can block channels like Discord when only "telegram" is listed).
const pluginsBlock = config.plugins;
if (pluginsBlock && Array.isArray(pluginsBlock.allow)) {
  delete pluginsBlock.allow;
  console.log("Removed plugins.allow (allowlist filtering breaks built-in channels)");
  changed = true;
}

// ── Web tools ──────────────────────────────────────────────────────
const tools = ensureObject(config, "tools");
const webTools = ensureObject(tools, "web");

// web_fetch: always enabled (no API key required for basic operation).
const webFetch = ensureObject(webTools, "fetch");
if (webFetch.enabled !== true) {
  webFetch.enabled = true;
  console.log("Set tools.web.fetch.enabled=true");
  changed = true;
}

// Firecrawl fallback for web_fetch (bot-circumvention).
const firecrawlApiKey = trimValue(process.env.FIRECRAWL_API_KEY);
if (firecrawlApiKey) {
  const firecrawl = ensureObject(webFetch, "firecrawl");
  if (firecrawl.enabled !== true) {
    firecrawl.enabled = true;
    console.log("Set tools.web.fetch.firecrawl.enabled=true");
    changed = true;
  }
} else {
  // Disable Firecrawl if key was removed.
  if (webFetch.firecrawl && webFetch.firecrawl.enabled === true) {
    webFetch.firecrawl.enabled = false;
    console.log("Set tools.web.fetch.firecrawl.enabled=false (key removed)");
    changed = true;
  }
}

// web_search: enabled when BRAVE_API_KEY or PERPLEXITY_API_KEY is set.
// Brave takes priority (it is the OpenClaw default provider).
const braveApiKey = trimValue(process.env.BRAVE_API_KEY);
const perplexityApiKey = trimValue(process.env.PERPLEXITY_API_KEY);
const webSearch = ensureObject(webTools, "search");

if (braveApiKey) {
  if (webSearch.enabled !== true) {
    webSearch.enabled = true;
    console.log("Set tools.web.search.enabled=true");
    changed = true;
  }
  if (webSearch.provider !== "brave") {
    webSearch.provider = "brave";
    console.log("Set tools.web.search.provider=brave");
    changed = true;
  }
} else if (perplexityApiKey) {
  if (webSearch.enabled !== true) {
    webSearch.enabled = true;
    console.log("Set tools.web.search.enabled=true");
    changed = true;
  }
  if (webSearch.provider !== "perplexity") {
    webSearch.provider = "perplexity";
    console.log("Set tools.web.search.provider=perplexity");
    changed = true;
  }
} else {
  // No search API key available — disable search if it was previously auto-wired.
  if (webSearch.enabled === true) {
    webSearch.enabled = false;
    console.log("Set tools.web.search.enabled=false (no search API key)");
    changed = true;
  }
}

// ── Gmail (gog) auto-wiring ──────────────────────────────────────
// When GOG_ACCOUNT is set (and hooks are enabled), configure the Gmail
// Pub/Sub integration.  The gateway auto-starts `gog gmail watch serve`
// when hooks.gmail.account is present.
const gogAccount = trimValue(process.env.GOG_ACCOUNT);
if (gogAccount) {
  // Gmail requires hooks — the watcher daemon posts to the hooks endpoint.
  if (hooks.enabled !== true && hooksToken) {
    hooks.enabled = true;
    console.log("Set hooks.enabled=true (required for Gmail integration)");
    changed = true;
  }

  // Ensure "gmail" preset is in hooks.presets so the gateway loads the handler.
  const hooksPresets = ensureArray(hooks, "presets");
  if (!hooksPresets.includes("gmail")) {
    hooksPresets.push("gmail");
    console.log('Added "gmail" to hooks.presets');
    changed = true;
  }

  const gmail = ensureObject(hooks, "gmail");

  if (gmail.account !== gogAccount) {
    gmail.account = gogAccount;
    console.log(`Set hooks.gmail.account=${gogAccount}`);
    changed = true;
  }

  // Daemon bind configuration — loopback-only, gateway auto-starts it.
  const serve = ensureObject(gmail, "serve");
  if (serve.bind !== "127.0.0.1") {
    serve.bind = "127.0.0.1";
    console.log("Set hooks.gmail.serve.bind=127.0.0.1");
    changed = true;
  }
  if (serve.port !== 8788) {
    serve.port = 8788;
    console.log("Set hooks.gmail.serve.port=8788");
    changed = true;
  }

  // Ensure a binding exists for the hooks agent to receive Gmail hook invocations.
  const bindings = ensureArray(config, "bindings");
  const hasHooksBinding = bindings.some(
    (binding) =>
      binding &&
      typeof binding === "object" &&
      binding.agentId === "hooks" &&
      binding.match &&
      typeof binding.match === "object" &&
      binding.match.channel === "hooks",
  );
  if (!hasHooksBinding) {
    bindings.push({
      agentId: "hooks",
      match: { channel: "hooks" },
    });
    console.log("Added hooks binding for agent hooks (Gmail)");
    changed = true;
  }

  if (!hooksToken) {
    console.log(
      "Warning: GOG_ACCOUNT is set but OPENCLAW_HOOKS_TOKEN is missing. " +
        "Gmail integration requires hooks to be enabled. Set OPENCLAW_HOOKS_TOKEN.",
    );
  }
} else {
  // GOG_ACCOUNT absent or empty — clean up Gmail config if previously auto-wired.
  if (hooks.gmail && hooks.gmail.account) {
    delete hooks.gmail;
    console.log("Removed hooks.gmail (GOG_ACCOUNT unset)");
    changed = true;
  }
  if (Array.isArray(hooks.presets)) {
    const gmailIdx = hooks.presets.indexOf("gmail");
    if (gmailIdx !== -1) {
      hooks.presets.splice(gmailIdx, 1);
      console.log('Removed "gmail" from hooks.presets');
      changed = true;
    }
    if (hooks.presets.length === 0) {
      delete hooks.presets;
    }
  }
  if (Object.prototype.hasOwnProperty.call(process.env, "GOG_ACCOUNT")) {
    console.log("Skipping Gmail auto-wiring: GOG_ACCOUNT is set but empty.");
  }
}

if (changed) {
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
} else {
  console.log("Runtime config already matches desired state.");
}
