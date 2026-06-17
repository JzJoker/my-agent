import { bash } from "./bash";
import { getComposioTools } from "./composio";
import { readFile, writeFile } from "./files";
import { web_extract, web_search } from "./web";

// The agent's full toolset: built-ins plus any connected Composio (Gmail/Calendar)
// tools. Composio is fetched once at module load.
export const tools = {
  bash,
  readFile,
  writeFile,
  web_search,
  web_extract,
  ...(await getComposioTools()),
};
