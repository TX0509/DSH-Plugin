/**
 * dsh-dev-commands - Host half of the slash-command bundle.
 *
 * Adds two commands to the composer's slash menu:
 *   /review  - ask the Agent to review uncommitted changes
 *   /ship    - ask the Agent to commit all uncommitted changes and push
 *
 * The commands do not run git themselves. They submit one ordinary user
 * message through the receiving Agent (`agent.steer`), so the Agent uses its
 * normal bash/git tools, approval policy, and sandbox. The slash line and the
 * direct command result stay outside model history; only the generated prompt
 * becomes a normal user message.
 */
import { randomUUID } from 'node:crypto'

/** Plugin identity for cordis rows / diagnostics. */
export const name = 'dsh-dev-commands'

/** The command registry is the only required service. */
export const inject = ['commands']

const REVIEW_COMMAND = 'review'
const SHIP_COMMAND = 'ship'
const REVIEW_DESCRIPTION = '审查当前工作区未提交的改动'
const SHIP_DESCRIPTION = '提交全部本地未提交改动并推送'

/**
 * Build the user-role message that enters the Agent inbox. The command
 * registry hands the real Agent to the handler; the message shape mirrors
 * `createUserMessage` from the shipped packages without importing an internal
 * Host package into this profile plugin.
 */
function createUserMessage(text) {
  const block = Object.freeze({ type: 'text', text })
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: Object.freeze([block]),
    source: Object.freeze({ kind: 'user' })
  })
}

/** Review the uncommitted workspace by default; `focus` narrows the review. */
function reviewPrompt(focus) {
  const lines = [
    '请审查当前工作区中尚未提交的改动。',
    '',
    '执行步骤：',
    '1. 运行 `git status --short`，区分已暂存、未暂存和未跟踪的文件。',
    '2. 运行 `git diff --cached` 和 `git diff`；未跟踪的文件直接读取内容。',
    '3. 重点检查正确性、回归风险、安全问题、性能问题、缺失的测试，以及与仓库现有约定不一致的地方。',
    '4. 按严重程度从高到低列出问题，尽量给出 `文件:行号` 和可操作的修复建议；没有发现问题时明确说明。',
    '5. 只做审查：不要修改任何文件，也不要提交或推送。',
    '',
    '如果没有未提交的改动，直接说明。'
  ]
  if (focus !== '') {
    lines.push('', `额外关注点（优先检查）：${focus}`)
  }
  return lines.join('\n')
}

/** Commit and push every uncommitted change by default; `hint` guides the message. */
function shipPrompt(hint) {
  const lines = [
    '请提交并推送当前工作区中所有尚未提交的改动。',
    '',
    '执行步骤：',
    '1. 运行 `git status --short`，确认已暂存、未暂存和未跟踪的文件。',
    '2. 运行 `git diff` 和 `git diff --cached` 了解改动内容。',
    '3. 默认把所有未提交改动（包括未跟踪文件，但不包括被 .gitignore 忽略的文件）加入暂存区，例如 `git add -A`。',
    '4. 根据实际改动生成一条简洁准确的提交信息，遵循仓库现有提交信息的语言和风格；如果下面提供了提交说明，以它为依据。',
    '5. 创建一次新的提交；不要 amend、rebase 或改写历史，也不要使用 `--no-verify`。',
    '6. 推送当前分支到它的 upstream；如果没有 upstream，使用 `git push -u origin <当前分支>`。',
    '7. 报告提交哈希、分支、远端和推送结果；如果没有可提交的改动，说明原因，不要创建空提交。',
    '8. 如果发现明显的密钥、凭据、个人隐私数据或不应提交的大型生成物，先停下来询问，不要直接提交。'
  ]
  if (hint !== '') {
    lines.push('', `提交说明/补充要求：${hint}`)
  }
  return lines.join('\n')
}

/** Submit one ordinary user message to the invoking Agent. */
function submit(agent, text, successText) {
  if (agent === null || agent === undefined || typeof agent.steer !== 'function') {
    return {
      kind: 'error',
      text: '当前命令没有可用的 Agent；请先打开一个会话再试。'
    }
  }
  try {
    agent.steer(createUserMessage(text))
    return { kind: 'success', text: successText }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { kind: 'error', text: `无法发起命令：${message}` }
  }
}

/**
 * Register one command. A duplicate name from another plugin must not take
 * down the whole bundle, so a conflict is logged and that one command is
 * skipped while the other still registers.
 */
function registerCommand(ctx, definition) {
  try {
    return ctx.commands.register(definition)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (ctx.logger !== undefined && typeof ctx.logger.warn === 'function') {
      ctx.logger.warn(`dsh-dev-commands: cannot register /${definition.name}: ${message}`)
    }
    return function () {}
  }
}

/** Register both commands and own their disposers. */
export function apply(ctx) {
  ctx.effect(function () {
    return registerCommand(ctx, {
      name: REVIEW_COMMAND,
      description: REVIEW_DESCRIPTION,
      input: { hint: '[额外关注点]' },
      handler: function (invocation) {
        return submit(
          invocation.agent,
          reviewPrompt(invocation.rawInput.trim()),
          '已发起代码审查，Agent 正在检查未提交的改动。'
        )
      }
    })
  }, 'dsh-dev-commands: /review')

  ctx.effect(function () {
    return registerCommand(ctx, {
      name: SHIP_COMMAND,
      description: SHIP_DESCRIPTION,
      input: { hint: '[提交说明]' },
      handler: function (invocation) {
        return submit(
          invocation.agent,
          shipPrompt(invocation.rawInput.trim()),
          '已发起提交并推送，Agent 正在处理本地改动。'
        )
      }
    })
  }, 'dsh-dev-commands: /ship')
}

export const __internals = {
  REVIEW_COMMAND,
  SHIP_COMMAND,
  REVIEW_DESCRIPTION,
  SHIP_DESCRIPTION,
  createUserMessage,
  reviewPrompt,
  shipPrompt,
  submit,
  registerCommand
}
