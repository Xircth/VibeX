"use client"

import { useState, useRef, useEffect, useCallback } from "react"
import { useTranslations } from "next-intl"
import { MessageCircleQuestion, SendHorizonal } from "lucide-react"
import { Button } from "@/components/ui/button"
import { matchShortcutEvent } from "@/lib/keyboard-shortcuts"
import { useShortcutSettings } from "@/hooks/use-shortcut-settings"
import type { PendingQuestion } from "@/contexts/acp-connections-context"

interface QuestionDialogProps {
  question: PendingQuestion | null
  onAnswer: (answer: string) => void
}

export function QuestionDialog({ question, onAnswer }: QuestionDialogProps) {
  const t = useTranslations("Folder.chat.questionDialog")
  const { shortcuts } = useShortcutSettings()
  const [answer, setAnswer] = useState("")
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const prevQuestionIdRef = useRef<string | null>(null)

  const questionId = question?.tool_call_id ?? null
  if (questionId !== prevQuestionIdRef.current) {
    prevQuestionIdRef.current = questionId
    if (questionId && answer !== "") {
      setAnswer("")
    }
  }

  useEffect(() => {
    if (question) {
      textareaRef.current?.focus()
    }
  }, [question])

  const handleSubmit = useCallback(() => {
    const trimmed = answer.trim()
    if (!trimmed) return
    onAnswer(trimmed)
    setAnswer("")
  }, [answer, onAnswer])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (matchShortcutEvent(e, shortcuts.send_message)) {
        e.preventDefault()
        handleSubmit()
      }
    },
    [handleSubmit, shortcuts]
  )

  if (!question) return null

  return (
    <div className="mx-4 mb-3 rounded-xl border border-blue-500/30 bg-card/95 p-3 shadow-sm">
      <div className="flex items-center gap-1.5 text-sm font-medium">
        <MessageCircleQuestion className="h-4 w-4 shrink-0 text-blue-500" />
        <span>{t("title")}</span>
      </div>

      <p className="mt-2 text-sm text-foreground/90 whitespace-pre-wrap">
        {question.question}
      </p>

      <div className="mt-3 flex gap-2">
        <textarea
          ref={textareaRef}
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t("placeholder")}
          rows={2}
          className="flex-1 resize-none rounded-md border border-border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
        <Button
          size="sm"
          disabled={!answer.trim()}
          onClick={handleSubmit}
          className="self-end"
        >
          <SendHorizonal className="mr-1.5 h-3.5 w-3.5" />
          {t("send")}
        </Button>
      </div>
    </div>
  )
}
