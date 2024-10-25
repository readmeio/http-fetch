import { CopilotError, CopilotErrorCodes, CopilotErrorType, CopilotMessage, GitHubMessage } from './types'
import OpenAI from 'openai'
import { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources'
import is_ip_private from 'private-ip'

type ChatCompletionRequestArgs = {
  messages: GitHubMessage[]
  token: string
}

const MAX_RESPONSE_SIZE = 3750

const tools: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'fetch',
      description: 'Make an HTTP request',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'The URL to make the request to',
          },
          method: {
            type: 'string',
            enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS', 'TRACE', 'CONNECT'],
            description: 'The HTTP method to use',
          },
          headers: {
            type: 'object',
            description: 'Headers to include in the request',
          },
          body: {
            type: 'string',
            description: 'The body of the request (for POST, PUT, PATCH)',
          },
        },
        required: ['url', 'method'],
      },
    },
  },
]

async function chatCompletionRequest({ token, messages }: ChatCompletionRequestArgs) {
  const client = new OpenAI({
    apiKey: token,
    baseURL: 'https://api.githubcopilot.com/',
  })
  const stream = client.beta.chat.completions.stream({
    messages: messages as ChatCompletionMessageParam[],
    model: 'gpt-4o',
    stream: true,
    tools,
  })

  return stream
}

type GenerateAgentResponseArgs = {
  history: GitHubMessage[]
  token: string
}
async function fetchTool({ url, method, headers, body }: { url: string; method: string; headers: Record<string, string>; body: string }) {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 5000)
  try {
    const parsedUrl = new URL(url)
    if (is_ip_private(parsedUrl.hostname) || parsedUrl.hostname === 'localhost' || parsedUrl.hostname === 'broadcasthost') {
      throw new Error('Cannot make requests to private IP addresses')
    }
  } catch (error: any) {
    throw new CopilotError({
      type: CopilotErrorType.agent,
      code: CopilotErrorCodes.readmeError,
      message: 'Invalid URL',
      identifier: 'fetch',
      originalError: error,
    })
  }

  try {
    const res = await fetch(url, {
      method,
      headers,
      body,
      signal: controller.signal,
    })
    clearTimeout(timeoutId)
    return res.text() || 'No response'
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new CopilotError({
        type: CopilotErrorType.agent,
        code: CopilotErrorCodes.githubError,
        message: 'Request took too long',
        identifier: 'fetch',
        originalError: error,
      })
    }
    throw error
  }
}
export async function generateAgentResponse({ history, token }: GenerateAgentResponseArgs) {
  // The last message is the current users message. We remove it here and make a prompt from it.
  const currentMessage = history.pop()
  if (!currentMessage) {
    throw new CopilotError({
      type: CopilotErrorType.agent,
      code: CopilotErrorCodes.githubError,
      message: 'No history provided',
    })
  }
  const confirm = (currentMessage as CopilotMessage)?.copilot_confirmations?.[0]
  if (confirm) {
    if (confirm.state !== 'accepted') {
      throw new CopilotError({
        type: CopilotErrorType.reference,
        code: CopilotErrorCodes.confirmationError,
        message: 'Aborted request, try again',
      })
    }
    if (confirm.confirmation.functionName !== 'fetch') {
      throw new CopilotError({
        type: CopilotErrorType.agent,
        code: CopilotErrorCodes.githubError,
        identifier: `invalid function: ${confirm.confirmation.functionName}`,
        message: 'Invalid function',
      })
    }
    // this is to remove extra empty assistant message
    history.pop()
    const rawResponse = await fetchTool(confirm.confirmation.args as any)
    let response = rawResponse.slice(0, MAX_RESPONSE_SIZE)
    if (response.length < rawResponse.length) {
      response += '... (truncated)'
    }
    // add the response to the history
    history.push(currentMessage)
    history.push({
      role: 'assistant',
      tool_calls: [{ type: 'function', function: { name: confirm.confirmation.functionName, arguments: JSON.stringify(confirm.confirmation.args) }, id: confirm.confirmation.id }],
    })
    history.push({
      role: 'tool',
      name: confirm.confirmation.functionName,
      tool_call_id: confirm.confirmation.id,
      content: response,
    })
  } else {
    const copilotMessage = currentMessage as CopilotMessage
    const context = copilotMessage.copilot_references?.length ? copilotMessage.copilot_references : undefined
    const prompt = `user message: ${copilotMessage.content}${context ? `\n\ncontext: ${JSON.stringify(context)}` : ''}`
    // add the last message back in with the generated prompt
    history.push({
      ...currentMessage,
      content: prompt,
    })
  }

  const messages = [
    {
      role: 'system',
      content: `You are a helpful HTTP request builder and executor assistant. Use the context passed by the user to build the correct request. Ask the user for clarification if you need it. Never make calls to localhost or 127.0.0.1 or 0.0.0.0 or any private IP addresses. Be sure to set content type headers if needed. for example use application/json if you need a json body. Ask the user if you need any required parameters. show the response exactly as it is.`,
    },
    ...history,
  ]

  return chatCompletionRequest({ token, messages })
}
