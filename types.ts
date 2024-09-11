// types from https://github.com/github-technology-partners/copilot-partners/blob/main/docs/request-response-format.md

import { ChatCompletionMessageToolCall } from 'openai/resources'

enum CopilotEventTypes {
  copilot_confirmation = 'copilot_confirmation', // send user references
  copilot_errors = 'copilot_errors', // send a user a confirmation
  copilot_references = 'copilot_references', // send user an error
}

export enum CopilotErrorType {
  agent = 'agent',
  function = 'function',
  reference = 'reference',
}

export enum CopilotErrorCodes {
  githubError = '100',
  readmeError = '101',
  confirmationError = '102',
}

export interface GenerateCopilotErrorArgs {
  code: CopilotErrorCodes
  identifier?: string
  message: string
  originalError?: Error
  type: CopilotErrorType
}

enum GitHubMessageConfirmationState {
  accepted = 'accepted',
  dismissed = 'dismissed',
}

export interface GitHubMessageConfirmations {
  confirmation: {
    id: string
    functionName: string
    args: Record<string, string>
  }
  state: GitHubMessageConfirmationState
}
export interface GithubReference {
  type: string
  data: {
    type: string
  } & Record<string, unknown>
  id: string
  is_implicit: boolean
  metadata: {
    display_name: string
    display_icon: string
    display_url: string
  }
}
export type CopilotMessage = {
  content: string
  copilot_confirmations?: GitHubMessageConfirmations[]
  copilot_references?: GithubReference[]
}
export type GitHubMessage = { role: string } & (
  | CopilotMessage
  | {
      tool_calls?: ChatCompletionMessageToolCall[]
    }
  | {
      name: string
      tool_call_id: string
      content: string
    }
)

export interface GenerateAgentResponseArgs {
  customization: Record<string, string>
  history: GitHubMessage[]
  projectName: string
  subdomains: string[]
  token: string
}

export type CopilotRequest = {
  copilot_thread_id: string
  messages: GitHubMessage[]
  stop: null | string
  top_p: number
  temperature: number
  max_tokens: number
  presence_penalty: number
  frequency_penalty: number
  copilot_skills: Record<string, string | number>[]
  agent: string
}

export class CopilotError extends Error {
  code: CopilotErrorCodes

  type: CopilotErrorType

  identifier: string

  originalError: Error | undefined

  constructor({ code, type, message, identifier, originalError }: GenerateCopilotErrorArgs) {
    super(message)
    this.name = 'CopilotError'
    this.code = code
    this.type = type
    this.identifier = identifier || 'error'
    this.originalError = originalError
  }

  generateCopilotError() {
    // this format is required by the client
    // see: https://github.com/github-technology-partners/copilot-partners/blob/main/docs/copilot-errors.md
    return `event: ${CopilotEventTypes.copilot_errors}\ndata: ${JSON.stringify([
      {
        type: this.type,
        code: this.code,
        message: this.message,
        identifier: this.identifier,
      },
    ])}\n\n`
  }
}
