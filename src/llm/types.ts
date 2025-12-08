/**
 * Shared LLM interface types
 */

import { TranscriptMessage, ConversationState } from "../types/retell.js";

/**
 * Response from LLM generateResponse
 */
export interface LLMResponse {
  content: string;
  endCall: boolean;
  transferNumber?: string;
}

/**
 * Interface for LLM handlers (Claude, OpenAI, etc.)
 */
export interface LLMHandler {
  /**
   * Get the initial greeting based on call direction
   */
  getInitialGreeting(direction?: "inbound" | "outbound"): string;

  /**
   * Get a reminder message when user is silent
   */
  getReminder(): string;

  /**
   * Generate a response based on the conversation transcript
   */
  generateResponse(
    transcript: TranscriptMessage[],
    onIntermediateResponse?: (text: string) => void
  ): Promise<LLMResponse>;
}

/**
 * LLM Provider types
 */
export type LLMProvider = "claude" | "openai";
