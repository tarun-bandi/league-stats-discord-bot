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

const riotIdOption = {
  name: "summoner",
  description: "Riot ID in Game Name#TAG format",
  type: 3,
  required: true,
};

const regionOption = {
  name: "region",
  description: "League region (defaults to NA)",
  type: 3,
  required: false,
  choices: REGION_CHOICES.map(([name, value]) => ({ name, value })),
};

export const COMMANDS = [
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
    ],
  },
  {
    name: "live",
    type: 1,
    description: "Check whether a summoner is currently in a League game",
    dm_permission: false,
    options: [riotIdOption, regionOption],
  },
  {
    name: "ping",
    type: 1,
    description: "Check whether LeagueStats is online",
    dm_permission: false,
  },
];
