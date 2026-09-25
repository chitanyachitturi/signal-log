import "dotenv/config";

/**
 * News sources. Add, remove or edit feeds here.
 * - stream: the default topic ("ai" or "aws"); Claude may add the other one if the story covers both.
 * - maxItems: how many of the newest items to consider from this feed each run.
 * - keywords (optional): only keep items whose title/description matches one of these (case-insensitive).
 */
export const FEEDS = [
  // ---- AWS ----
  { name: "AWS News Blog",        url: "https://aws.amazon.com/blogs/aws/feed/",                      stream: "aws", maxItems: 10 },
  { name: "AWS What's New",       url: "https://aws.amazon.com/about-aws/whats-new/recent/feed/",     stream: "aws", maxItems: 15,
    keywords: ["bedrock", "agentcore", "sagemaker", "ai", "nova", "quick", "ec2", "lambda", "generally available", "q developer", "transform"] },
  { name: "AWS Machine Learning Blog", url: "https://aws.amazon.com/blogs/machine-learning/feed/",    stream: "aws", maxItems: 8 },

  // ---- AI ----
  { name: "TechCrunch AI",        url: "https://techcrunch.com/category/artificial-intelligence/feed/", stream: "ai", maxItems: 10 },
  { name: "The Verge AI",         url: "https://www.theverge.com/rss/ai-artificial-intelligence/index.xml", stream: "ai", maxItems: 10 },
  { name: "MIT Technology Review",url: "https://www.technologyreview.com/topic/artificial-intelligence/feed", stream: "ai", maxItems: 6 },
  { name: "Google AI Blog",       url: "https://blog.google/technology/ai/rss/",                      stream: "ai", maxItems: 6 },
  { name: "OpenAI News",          url: "https://openai.com/news/rss.xml",                             stream: "ai", maxItems: 6 },
  { name: "Hugging Face Blog",    url: "https://huggingface.co/blog/feed.xml",                        stream: "ai", maxItems: 6 },
];

const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);

export const SETTINGS = {
  port: num(process.env.PORT, 3000),
  model: process.env.CLAUDE_MODEL || "claude-haiku-4-5-20251001",
  hasApiKey: Boolean(process.env.ANTHROPIC_API_KEY),
  refreshMinutes: num(process.env.REFRESH_MINUTES, 30),
  maxNewPerRun: num(process.env.MAX_NEW_PER_RUN, 25),
  maxAgeDays: num(process.env.MAX_AGE_DAYS, 21),
  maxStored: 600,
  adminToken: process.env.ADMIN_TOKEN || "",
  articleCharLimit: 12000, // how much article text is sent to Claude
  fetchTimeoutMs: 15000,
};
