import { CopilotError, CopilotErrorCodes, CopilotErrorType, CopilotMessage, GitHubMessage } from './types'
import OpenAI from 'openai'
import { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources'

type ChatCompletionRequestArgs = {
  messages: GitHubMessage[]
  token: string
}

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
  const res = await fetch(url, {
    method,
    headers,
    body,
  })

  return res.text()
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
    const response = await fetchTool(confirm.confirmation.args as any)
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
      content: `You are an HTTP request builder and executor. Use the context passed by the user to build the correct request. Ask the user for clarification if you need it. Ask the user if you need any required parameters. show the response exactly as it is.`,
    },
    ...history,
  ]

  return chatCompletionRequest({ token, messages })
}