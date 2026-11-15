/** Item notes of a vault list folder: skips Zoottelkeeper's _Index_ files and the "<Folder> Overview" journal pages. */
export const isItemNote = file => file.endsWith(".md") && !file.startsWith("_Index_") && !file.endsWith(" Overview.md");
