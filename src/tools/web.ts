import { tool } from "ai";
import { z } from "zod";
import { truncate } from "./util";

// Web tools are backed by Tavily, but that's an implementation detail — the
// agent only sees generic web_search / web_extract tools.
const tavily = async (endpoint: "search" | "extract", body: object) => {
  const r = await fetch(`https://api.tavily.com/${endpoint}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.TAVILY_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return r.json() as Promise<any>;
};

export const web_search = tool({
  description:
    "Search the web. Returns the top results with title, URL, and a content snippet. " +
    "Use web_extract afterward to read the full text of a promising result.",
  inputSchema: z.object({ query: z.string().describe("The search query.") }),
  execute: async ({ query }) => {
    const data = await tavily("search", { query, max_results: 5 });
    return {
      results: (data.results ?? []).map((r: any) => ({
        title: r.title,
        url: r.url,
        snippet: r.content,
      })),
      ...(data.answer && { answer: data.answer }),
    };
  },
});

export const web_extract = tool({
  description:
    "Extract the full text of one or more web pages (also works on PDF URLs, e.g. arxiv). " +
    "Use after web_search to read a page. Very long pages are truncated.",
  inputSchema: z.object({
    urls: z.array(z.string()).describe("Page URLs to read."),
  }),
  execute: async ({ urls }) => {
    const data = await tavily("extract", { urls });
    return {
      results: (data.results ?? []).map((r: any) => ({
        url: r.url,
        content: truncate(r.raw_content ?? ""),
      })),
      ...(data.failed_results?.length && {
        failed: data.failed_results.map((f: any) => f.url ?? f),
      }),
    };
  },
});
