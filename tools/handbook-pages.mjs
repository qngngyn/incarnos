/** Ordered journal sidebar. Paths are relative to the vault's System Files folder. */
export const HANDBOOK_PAGES = [
  { level: 1, path: "Incarnos Handbook.md" },
  { level: 1, path: "Rules/Rules Overview.md" },
  ...["How To Play", "Character Creation", "Attributes And Stats", "List Of Actions", "Magic", "Level Table", "List Of Links"]
    .map(name => ({ level: 2, path: `Rules/Discord Important (new)/${name}.md` })),
  { level: 2, path: "Rules/Incarnos Rules.md" },
  { level: 1, path: "Listen/Lists Overview.md" },
  ...["Weapons", "Weapon Traits", "Talents", "Races", "Spells", "Conditions"]
    .map(name => ({ level: 2, path: `Listen/${name}/${name} Overview.md` })),
  { level: 2, path: "Listen/Actionlists/Action Lists Overview.md" },
  { level: 3, path: "Listen/Actionlists/Incarnos_Actionlist_Recruit_v10.md", name: "Recruit Action List" },
  { level: 3, path: "Listen/Actionlists/Incarnos_Actionlist_Veteran_v10.md", name: "Veteran Action List" },
  { level: 2, path: "Listen/Tables/Tables Overview.md" },
  { level: 3, path: "Listen/Tables/Critical Failures.md" }
];
