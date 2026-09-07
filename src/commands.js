import { MODE_CHOICES } from "./league.js";

export const REGION_CHOICES = [
  ["NA", "na"],
  ["EU West", "euw"],
  ["EU Nordic & East", "eune"],
  ["Korea", "kr"],
  ["Brazil", "br"],
  ["Oceania", "oce"],
  ["Japan", "jp"],
  ["Latin America North", "lan"],
  ["Latin America South", "las"],
  ["Türkiye", "tr"],
  ["Philippines", "ph"],
  ["Singapore", "sg"],
  ["Thailand", "th"],
  ["Taiwan", "tw"],
  ["Vietnam", "vn"],
];

export const MONITORED_SUMMONER_DEFAULTS = [
  "HelloThere#9494",
  "TIXBS Chaos#NA1",
  "Knaye East#YEEZY",
];

const riotIdOption = {
  name: "summoner",
  description: "Riot ID; monitored accounts are suggested as you type",
  type: 3,
  required: false,
  autocomplete: true,
};

const regionOption = {
  name: "region",
  description: "League region (defaults to NA)",
  type: 3,
  required: false,
  choices: REGION_CHOICES.map(([name, value]) => ({ name, value })),
};

const modeOption = {
  name: "mode", description: "Filter by game mode (defaults to all modes)",
  type: 4, required: false, choices: MODE_CHOICES,
};

const privateOption = { name: "private", description: "Show the response only to you", type: 5, required: false };
const requiredSummoner = { ...riotIdOption, required: true };
const trackerCommand = (name, description) => ({ name, description, type: 1, options: [requiredSummoner] });

const daysOption = { name: "days", description: "Rolling period: 1–30 days (default 7)", type: 4, min_value: 1, max_value: 30 };
export const LEADERBOARD_METRICS = [
  ["Win rate", "winRate"], ["KDA", "kda"], ["CS/min", "csPerMinute"],
  ["Damage/min", "averageDamagePerMinute"], ["Average vision", "averageVision"],
  ["Hours played", "hours"], ["Games played", "games"],
];

export const COMMANDS = [
  { name: "lpgraph", type: 1, description: "Graph a tracked player's observed rank and LP over 1–30 days", dm_permission: false, options: [
    riotIdOption, daysOption,
    { name: "queue", description: "Ranked queue (default both)", type: 3, choices: [{ name: "Both", value: "both" }, { name: "Solo/Duo", value: "solo" }, { name: "Flex", value: "flex" }] },
    privateOption,
  ] },
  { name: "summary", type: 1, description: "Last seven days of tracked games, highlights and observed LP gains", dm_permission: false, options: [privateOption] },
  { name: "weekly", type: 1, description: "Configure Monday 16:00 UTC server recaps", dm_permission: false, default_member_permissions: "32", options: [
    { name: "enable", type: 1, description: "Post weekly recaps in this channel starting next Monday at 16:00 UTC" },
    { name: "disable", type: 1, description: "Stop automatic weekly recaps" },
    { name: "status", type: 1, description: "Show weekly recap schedule and delivery status" },
  ] },
  {
    name: "leaderboard", type: 1, description: "Automatically rank up to 10 active tracked players", dm_permission: false,
    options: [
      { name: "metric", description: "Sort by (default win rate)", type: 3, choices: LEADERBOARD_METRICS.map(([name, value]) => ({ name, value })) },
      daysOption, modeOption,
      { name: "min_games", description: "Minimum sampled games to qualify (default 5)", type: 4, min_value: 1, max_value: 30 }, privateOption,
    ],
  },
  {
    name: "compare", type: 1, description: "Compare two players over the same period and game mode", dm_permission: false,
    options: [{ ...requiredSummoner, name: "opponent", description: "Other player's Riot ID" }, riotIdOption, daysOption, regionOption, modeOption, privateOption],
  },
  {
    name: "help",
    type: 1,
    description: "Show LeagueStats commands and quick examples",
    dm_permission: false,
  },
  {
    name: "stats",
    type: 1,
    description: "Show win rate, games per day, rank, KDA, CS, and champions",
    dm_permission: false,
    options: [
      riotIdOption,
      {
        name: "days",
        description: "Rolling period from 1 to 30 days (defaults to 7)",
        type: 4,
        required: false,
        min_value: 1,
        max_value: 30,
      },
      regionOption,
      modeOption,
      {
        name: "champion",
        description: "Champion-specific stats; starts with 30 games, with Load more on the card",
        type: 3,
        required: false,
        autocomplete: true,
        min_length: 1,
        max_length: 100,
      },
      privateOption,
    ],
  },
  {
    name: "recent",
    type: 1,
    description: "Show a summoner's recent League games",
    dm_permission: false,
    options: [
      riotIdOption,
      {
        name: "count",
        description: "Number of games from 1 to 10 (defaults to 5)",
        type: 4,
        required: false,
        min_value: 1,
        max_value: 10,
      },
      regionOption,
      modeOption,
      privateOption,
    ],
  },
  {
    name: "live",
    type: 1,
    description: "Check whether a summoner is currently in a League game",
    dm_permission: false,
    options: [riotIdOption, regionOption, privateOption],
  },
  {
    name: "session", type: 1, description: "Today's wins, losses, play time, best champion and observed LP change",
    dm_permission: false, options: [riotIdOption, regionOption, modeOption, privateOption],
  },
  {
    name: "profile", type: 1, description: "Save your personal LeagueStats defaults", dm_permission: false,
    options: [
      { name: "set", description: "Save or update your defaults in this server", type: 1, options: [
        riotIdOption, regionOption, modeOption, privateOption,
        { name: "timezone", description: "IANA time zone, e.g. America/New_York or Europe/London", type: 3, max_length: 64 },
      ] },
      { name: "show", description: "Show your saved defaults privately", type: 1 },
      { name: "clear", description: "Clear your saved defaults in this server", type: 1 },
    ],
  },
  {
    name: "track", type: 1, description: "Admin controls for the LeagueStats monitor", dm_permission: false,
    default_member_permissions: "32",
    options: [
      trackerCommand("add", "Track an NA account from now, without historical alerts"),
      trackerCommand("remove", "Archive a tracker while preserving its history"),
      trackerCommand("pause", "Pause new alerts; existing live alerts still finish"),
      trackerCommand("resume", "Resume from now without replaying paused games"),
      { name: "list", description: "List active, paused and archived trackers", type: 1 },
      { name: "alerts", description: "Choose channel alert verbosity", type: 1, options: [
        { name: "mode", description: "Live and completed, or completed only", type: 3, required: true,
          choices: [{ name: "Live + completed", value: "all" }, { name: "Completed only", value: "completed" }] },
      ] },
      { name: "notifications", description: "Choose who receives credential failure/recovery DMs", type: 1, options: [
        { name: "owner", description: "Notification recipient; defaults to the server owner", type: 6, required: true },
      ] },
    ],
  },
  {
    name: "ping",
    type: 1,
    description: "Check whether LeagueStats is online",
    dm_permission: false,
  },
];
