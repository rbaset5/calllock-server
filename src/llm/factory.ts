/**
 * LLM Factory - Creates the appropriate LLM handler based on configuration
 */

import { ConversationState } from "../types/retell.js";
import { LLMHandler, LLMProvider } from "./types.js";
import { CallLockLLM } from "./claude.js";
import { OpenAILLM } from "./openai.js";
import { logger } from "../utils/logger.js";

/**
 * Get the configured LLM provider from environment
 * Defaults to "claude" if not specified
 */
export function getLLMProvider(): LLMProvider {
  const provider = (process.env.LLM_PROVIDER || "claude").toLowerCase();

  if (provider !== "claude" && provider !== "openai") {
    logger.warn(
      { provider },
      `Unknown LLM_PROVIDER "${provider}", defaulting to "claude"`
    );
    return "claude";
  }

  return provider as LLMProvider;
}

/**
 * Create an LLM handler instance based on the configured provider
 */
export function createLLMHandler(state: ConversationState): LLMHandler {
  const provider = getLLMProvider();

  logger.info({ provider }, "Creating LLM handler");

  switch (provider) {
    case "openai":
      // Verify OpenAI API key is configured
      if (!process.env.OPENAI_API_KEY) {
        logger.error("OPENAI_API_KEY not configured but LLM_PROVIDER=openai");
        throw new Error("OPENAI_API_KEY environment variable is required when LLM_PROVIDER=openai");
      }
      return new OpenAILLM(state);

    case "claude":
    default:
      // Verify Anthropic API key is configured
      if (!process.env.ANTHROPIC_API_KEY) {
        logger.error("ANTHROPIC_API_KEY not configured but LLM_PROVIDER=claude");
        throw new Error("ANTHROPIC_API_KEY environment variable is required when LLM_PROVIDER=claude");
      }
      return new CallLockLLM(state);
  }
}

/**
 * Validate LLM configuration at startup
 */
export function validateLLMConfig(): void {
  const provider = getLLMProvider();

  if (provider === "openai" && !process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required when LLM_PROVIDER=openai");
  }

  if (provider === "claude" && !process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is required when LLM_PROVIDER=claude");
  }

  logger.info({ provider }, "LLM configuration validated");
}
