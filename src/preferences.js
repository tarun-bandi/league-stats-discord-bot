import { readRecord, writeRecord, deleteRecord } from "./store.js";

export const userId = (interaction) => interaction.member?.user?.id ?? interaction.user?.id;
export const commandOptions = (interaction) => interaction.data?.options?.[0]?.type === 1
  ? interaction.data.options[0].options ?? [] : interaction.data?.options ?? [];
export const optionsObject = (interaction) => Object.fromEntries(commandOptions(interaction).map((option) => [option.name, option.value]));
const profileKey = (interaction) => {
  if (!interaction.guild_id || !userId(interaction)) throw new Error("Use this command in a server");
  return `profile:${interaction.guild_id}:${userId(interaction)}`;
};

export async function readProfile(interaction, env) {
  return await readRecord(env.MONITOR_DB, profileKey(interaction)) ?? {};
}

export async function saveProfile(interaction, env, profile) {
  await writeRecord(env.MONITOR_DB, profileKey(interaction), profile);
}

export async function clearProfile(interaction, env) {
  await deleteRecord(env.MONITOR_DB, profileKey(interaction));
}

export function withDefaults(interaction, profile = {}) {
  const explicit = optionsObject(interaction);
  const options = { ...profile, ...explicit };
  return { ...interaction, data: { ...interaction.data, options: Object.entries(options).map(([name, value]) => ({ name, value })) } };
}
