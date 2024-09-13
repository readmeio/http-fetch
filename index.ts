import express from 'express'
import { CopilotError, CopilotErrorCodes, CopilotErrorType, CopilotRequest } from './types'
import crypto from 'crypto'
import { generateAgentResponse } from './actions'

const app = express()
const port = process.env.PORT || 9121

const GITHUB_KEYS_URI = 'https://api.github.com/meta/public_keys/copilot_api'

app.use(express.json())

function generateConfirmationMsg({ title, message, data }: { title: string; message: string; data: Record<string, string | number> }) {
  // this format is required by the client
  // see: https://docs.github.com/en/copilot/building-copilot-extensions/building-a-copilot-agent-for-your-copilot-extension/configuring-your-copilot-agent-to-communicate-with-the-copilot-platform#copilot_confirmation
  return `event: copilot_confirmation\ndata: ${JSON.stringify({
    type: 'action',
    title,
    // Confirmation message shown to the user.
    message,
    // Optional field for the agent to include any data needed to uniquely identify this confirmation and take action once the decision is received from the client.
    confirmation: data,
  })}\n\n`
}

async function verifyPayload({ payload, signature, keyID }: { payload: string; signature: string; keyID: string }) {
  const keysRes = await fetch(GITHUB_KEYS_URI)
  const keys = (await keysRes.json()) as { public_keys: { key_identifier: string; key: string }[] }
  const publicKey = keys.public_keys.find((k) => k.key_identifier === keyID)
  if (!publicKey) {
    throw new CopilotError({
      type: CopilotErrorType.agent,
      code: CopilotErrorCodes.githubError,
      message: 'No public key found matching key identifier',
    })
  }
  const verify = crypto.createVerify('SHA256').update(payload)
  if (!verify.verify(publicKey.key, signature, 'base64')) {
    throw new CopilotError({
      type: CopilotErrorType.agent,
      code: CopilotErrorCodes.githubError,
      message: 'Signature does not match payload',
    })
  }
}

app.post('/agent', async (req, res) => {
  res.type('text/event-stream')
  res.setHeader('Transfer-Encoding', 'chunked')
  try {
    const token = req.headers['x-github-token']
    if (!token || typeof token !== 'string') {
      throw new CopilotError({
        type: CopilotErrorType.agent,
        code: CopilotErrorCodes.readmeError,
        message: 'Not authorized with github',
        identifier: 'agent',
      })
    }
    const body: CopilotRequest = req.body
    const signature = req.headers['github-public-key-signature'] as string
    const keyID = req.headers['github-public-key-identifier'] as string
    if (!signature || !keyID) {
      throw new CopilotError({
        type: CopilotErrorType.agent,
        code: CopilotErrorCodes.readmeError,
        message: 'Not authorized with github',
        identifier: 'agent',
      })
    }

    await verifyPayload({
      payload: JSON.stringify(body),
      signature,
      keyID,
    })

    const history = body.messages

    const stream = await generateAgentResponse({
      token,
      history,
    })
    for await (const chunk of stream) {
      const resMsg = `data: ${JSON.stringify(chunk)}\n\n`
      res.write(resMsg)
    }

    const chatCompletion = await stream.finalChatCompletion()
    // only support one tool call for now
    const toolCall = chatCompletion?.choices?.[0]?.message?.tool_calls?.[0]
    if (toolCall) {
      const functionName = toolCall.function.name
      if (functionName !== 'fetch') {
        throw new CopilotError({
          type: CopilotErrorType.function,
          code: CopilotErrorCodes.readmeError,
          identifier: `invalid function: ${functionName}`,
          message: 'Issue processing request, try stating the request again',
        })
      }
      const rawArgs = toolCall.function.arguments
      let args
      try {
        args = JSON.parse(rawArgs)
      } catch (error) {
        throw new CopilotError({
          type: CopilotErrorType.agent,
          code: CopilotErrorCodes.readmeError,
          message: 'Issue processing request, try stating the request again',
          originalError: error as Error,
        })
      }
      if (!args.url && !args.method) {
        throw new CopilotError({
          type: CopilotErrorType.function,
          code: CopilotErrorCodes.readmeError,
          identifier: `function missing args: ${rawArgs}`,
          message: 'Issue processing request, try stating the request again',
        })
      }

      const confirmationMsg = generateConfirmationMsg({
        title: 'Confirmation',
        message: `Do you want to make this request?\nmethod: ${args.method}\nurl: ${args.url}${args.body ? `\nbody: ${JSON.stringify(args.body, null, 2)}` : ''}${
          args.headers ? `\nheaders: ${JSON.stringify(args.headers, null, 2)}` : ''
        }`,
        data: {
          args,
          functionName,
          id: toolCall.id,
        },
      })
      // newlines at the start to ignore previous messages
      res.write(`\n\n`)
      res.write(confirmationMsg)
      return res.write(`\n\n`)
    }

    res.write(`data: [DONE]\n\n`)
  } catch (e) {
    let finalError = e as CopilotError
    if (finalError.name !== 'CopilotError') {
      finalError = new CopilotError({
        type: CopilotErrorType.agent,
        code: CopilotErrorCodes.readmeError,
        message: 'Issue processing request',
        originalError: e as Error,
      })
    }

    console.error(
      JSON.stringify({
        stack: finalError.stack?.replace(/\n   /g, ' |'),
        message: finalError.message,
      })
    )

    res.write(finalError.generateCopilotError())
  } finally {
    res.end()
  }
})

app.listen(port, () => {
  console.log(`Server is running on port ${port}`)
})
