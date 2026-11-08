import CompanionCore
import SwiftUI

/// SwiftUI port of VibeX desktop's `AgentQuestionCard`: collapsible header with position badge (`1 / N`),
/// single/multi-select option rows with `(Recommended)` badge, toggleable custom answer option row,
/// and pagination/submit footer (`上一题`, `跳过`, `下一题` / `提交`).
struct ApprovalCard: View {
    let request: PendingQuestion
    let busy: Bool
    let respond: (JSONValue?) -> Void

    @State private var index = 0
    @State private var answers: [String: QuestionAnswer] = [:]
    @State private var collapsed = false
    @FocusState private var customInputFocused: Bool

    private var questions: [FormQuestion] { QuestionForm.questions(for: request) }

    var body: some View {
        let items = questions
        let safeIndex = min(max(0, index), max(0, items.count - 1))
        if items.indices.contains(safeIndex) {
            card(items: items, activeIndex: safeIndex, current: items[safeIndex])
        }
    }

    private func card(items: [FormQuestion], activeIndex: Int, current: FormQuestion) -> some View {
        let headerTitle = current.header.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ? "问题确认"
            : current.header
        return VStack(alignment: .leading, spacing: 0) {
            // MARK: Header (`agent-question-header`)
            Button {
                withAnimation(.spring(response: 0.28, dampingFraction: 0.86)) {
                    collapsed.toggle()
                }
            } label: {
                HStack(spacing: 8) {
                    Text("\(activeIndex + 1) / \(items.count)")
                        .font(.system(size: 11.5, weight: .semibold, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 7)
                        .padding(.vertical, 2.5)
                        .background(
                            Color.primary.opacity(0.06),
                            in: Capsule()
                        )

                    Text(headerTitle)
                        .font(.system(size: 13.5, weight: .semibold))
                        .foregroundStyle(.primary)
                        .lineLimit(1)

                    Text("刚刚")
                        .font(.system(size: 11.5))
                        .foregroundStyle(.tertiary)

                    Spacer(minLength: 4)

                    Image(systemName: collapsed ? "chevron.down" : "chevron.up")
                        .font(.system(size: 11.5, weight: .semibold))
                        .foregroundStyle(.secondary)
                        .frame(width: 24, height: 24)
                        .background(Color.primary.opacity(0.04), in: Circle())
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 11)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if !collapsed {
                Divider().opacity(0.45)

                VStack(alignment: .leading, spacing: 12) {
                    // Prompt text (`agent-question-card-prompt`)
                    if !current.text.isEmpty {
                        Text(current.text)
                            .font(.system(size: 14, weight: .medium))
                            .foregroundStyle(.primary)
                            .fixedSize(horizontal: false, vertical: true)
                    }

                    // Options (`agent-question-options`)
                    VStack(spacing: 7) {
                        ForEach(current.choices) { choice in
                            choiceRow(choice, in: current)
                        }

                        customToggleRow(for: current)

                        if isCustomActive(in: current) {
                            customTextField(for: current)
                                .transition(.opacity.combined(with: .move(edge: .top)))
                        }
                    }

                    // Footer (`agent-question-footer`)
                    footer(items: items, activeIndex: activeIndex)
                }
                .padding(.horizontal, 14)
                .padding(.top, 12)
                .padding(.bottom, 13)
            }
        }
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(Color(.secondarySystemGroupedBackground))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(Color.primary.opacity(0.10), lineWidth: 0.75)
        )
        .shadow(color: .black.opacity(0.05), radius: 8, y: 2)
    }

    private func choiceRow(_ choice: QuestionChoice, in question: FormQuestion) -> some View {
        let selected = (answers[question.id]?.selected ?? []).contains(choice.value)
        return Button {
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            toggle(choice.value, in: question)
        } label: {
            HStack(alignment: .top, spacing: 10) {
                optionIndicator(selected: selected, multiSelect: question.multiSelect)
                    .padding(.top, 2)

                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        Text(choice.label)
                            .font(.system(size: 13.5, weight: selected ? .semibold : .regular))
                            .foregroundStyle(.primary)
                            .multilineTextAlignment(.leading)

                        if choice.recommended {
                            Text("推荐")
                                .font(.system(size: 10.5, weight: .semibold))
                                .foregroundStyle(Color.accentColor)
                                .padding(.horizontal, 6)
                                .padding(.vertical, 1.5)
                                .background(
                                    Color.accentColor.opacity(0.12),
                                    in: Capsule()
                                )
                        }
                    }

                    if let description = choice.description, !description.isEmpty {
                        Text(description)
                            .font(.system(size: 12))
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.leading)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }

                Spacer(minLength: 0)
            }
            .padding(.horizontal, 11)
            .padding(.vertical, 9)
            .background(
                RoundedRectangle(cornerRadius: 9, style: .continuous)
                    .fill(selected ? Color.accentColor.opacity(0.10) : Color(.tertiarySystemGroupedBackground))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 9, style: .continuous)
                    .strokeBorder(
                        selected ? Color.accentColor.opacity(0.55) : Color.primary.opacity(0.07),
                        lineWidth: selected ? 1.1 : 0.6
                    )
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(busy)
    }

    private func customToggleRow(for question: FormQuestion) -> some View {
        let active = isCustomActive(in: question)
        return Button {
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            withAnimation(.spring(response: 0.25, dampingFraction: 0.86)) {
                toggleCustom(in: question)
            }
        } label: {
            HStack(spacing: 10) {
                optionIndicator(selected: active, multiSelect: question.multiSelect)

                HStack(spacing: 5) {
                    Image(systemName: "square.and.pencil")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(active ? Color.accentColor : .secondary)
                    Text("自定义回答")
                        .font(.system(size: 13.5, weight: active ? .semibold : .regular))
                        .foregroundStyle(.primary)
                }

                Spacer(minLength: 0)
            }
            .padding(.horizontal, 11)
            .padding(.vertical, 9)
            .background(
                RoundedRectangle(cornerRadius: 9, style: .continuous)
                    .fill(active ? Color.accentColor.opacity(0.10) : Color(.tertiarySystemGroupedBackground))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 9, style: .continuous)
                    .strokeBorder(
                        active ? Color.accentColor.opacity(0.55) : Color.primary.opacity(0.07),
                        lineWidth: active ? 1.1 : 0.6
                    )
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(busy)
    }

    private func customTextField(for question: FormQuestion) -> some View {
        let binding = Binding<String>(
            get: { answers[question.id]?.customText ?? "" },
            set: { text in
                var entry = answers[question.id] ?? QuestionAnswer(customActive: true)
                entry.customActive = true
                entry.customText = text
                if !question.multiSelect, question.customFieldName == nil {
                    entry.selected = []
                }
                answers[question.id] = entry
            }
        )
        return TextField("请直接输入你的回答…", text: binding, axis: .vertical)
            .font(.system(size: 13.5))
            .lineLimit(1...4)
            .focused($customInputFocused)
            .keyboardType(question.valueType == .number || question.valueType == .integer ? .decimalPad : .default)
            .padding(.horizontal, 11)
            .padding(.vertical, 9)
            .background(
                RoundedRectangle(cornerRadius: 9, style: .continuous)
                    .fill(Color(.systemBackground))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 9, style: .continuous)
                    .strokeBorder(Color.accentColor.opacity(0.45), lineWidth: 1)
            )
            .disabled(busy)
    }

    @ViewBuilder
    private func optionIndicator(selected: Bool, multiSelect: Bool) -> some View {
        if multiSelect {
            RoundedRectangle(cornerRadius: 4.5, style: .continuous)
                .strokeBorder(selected ? Color.accentColor : Color.secondary.opacity(0.45), lineWidth: 1.4)
                .background(
                    RoundedRectangle(cornerRadius: 4.5, style: .continuous)
                        .fill(selected ? Color.accentColor : .clear)
                )
                .overlay {
                    if selected {
                        Image(systemName: "checkmark")
                            .font(.system(size: 9.5, weight: .bold))
                            .foregroundStyle(.white)
                    }
                }
                .frame(width: 16, height: 16)
        } else {
            Circle()
                .strokeBorder(selected ? Color.accentColor : Color.secondary.opacity(0.45), lineWidth: 1.4)
                .overlay {
                    if selected {
                        Circle()
                            .fill(Color.accentColor)
                            .frame(width: 8, height: 8)
                    }
                }
                .frame(width: 16, height: 16)
        }
    }

    private func footer(items: [FormQuestion], activeIndex: Int) -> some View {
        let isLast = activeIndex >= items.count - 1
        let complete = items.allSatisfy { !(answers[$0.id]?.isEmpty ?? true) }
        return HStack(spacing: 8) {
            if items.count > 1 {
                Button {
                    withAnimation(.easeInOut(duration: 0.18)) {
                        index = max(0, activeIndex - 1)
                    }
                } label: {
                    Text("上一题")
                        .font(.system(size: 12.5, weight: .medium))
                        .foregroundStyle(activeIndex == 0 ? .tertiary : .primary)
                        .padding(.horizontal, 11)
                        .frame(height: 30)
                        .background(
                            RoundedRectangle(cornerRadius: 8, style: .continuous)
                                .fill(Color(.tertiarySystemGroupedBackground))
                        )
                        .overlay(
                            RoundedRectangle(cornerRadius: 8, style: .continuous)
                                .strokeBorder(Color.primary.opacity(0.08), lineWidth: 0.6)
                        )
                }
                .buttonStyle(.plain)
                .disabled(busy || activeIndex == 0)
            }

            Spacer(minLength: 4)

            Button {
                respond(nil)
            } label: {
                Text("拒绝")
                    .font(.system(size: 12.5, weight: .medium))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 12)
                    .frame(height: 30)
                    .background(
                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                            .fill(Color(.tertiarySystemGroupedBackground))
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                            .strokeBorder(Color.primary.opacity(0.08), lineWidth: 0.6)
                    )
            }
            .buttonStyle(.plain)
            .disabled(busy)

            if isLast {
                Button {
                    let payload = QuestionForm.content(for: request, questions: items, answers: answers)
                    respond(payload)
                } label: {
                    HStack(spacing: 5) {
                        if busy {
                            ProgressView().controlSize(.mini).tint(.white)
                        }
                        Text("提交")
                            .font(.system(size: 12.5, weight: .semibold))
                    }
                    .foregroundStyle(complete && !busy ? Color(.systemBackground) : .secondary)
                    .padding(.horizontal, 14)
                    .frame(height: 30)
                    .background(
                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                            .fill(complete && !busy ? Color.primary : Color.primary.opacity(0.10))
                    )
                }
                .buttonStyle(.plain)
                .disabled(busy || !complete)
            } else {
                Button {
                    withAnimation(.easeInOut(duration: 0.18)) {
                        index = min(items.count - 1, activeIndex + 1)
                    }
                } label: {
                    Text("下一题")
                        .font(.system(size: 12.5, weight: .semibold))
                        .foregroundStyle(Color(.systemBackground))
                        .padding(.horizontal, 14)
                        .frame(height: 30)
                        .background(
                            RoundedRectangle(cornerRadius: 8, style: .continuous)
                                .fill(Color.primary)
                        )
                }
                .buttonStyle(.plain)
                .disabled(busy)
            }
        }
        .padding(.top, 2)
    }

    private func isCustomActive(in question: FormQuestion) -> Bool {
        if question.choices.isEmpty { return true }
        return answers[question.id]?.customActive == true
    }

    private func toggle(_ value: JSONValue, in question: FormQuestion) {
        var entry = answers[question.id] ?? QuestionAnswer()
        if question.multiSelect {
            if let existing = entry.selected.firstIndex(of: value) {
                entry.selected.remove(at: existing)
            } else {
                entry.selected.append(value)
            }
        } else {
            entry.selected = [value]
            if question.customFieldName == nil {
                entry.customActive = false
                entry.customText = ""
            }
        }
        answers[question.id] = entry
    }

    private func toggleCustom(in question: FormQuestion) {
        var entry = answers[question.id] ?? QuestionAnswer()
        if question.multiSelect {
            entry.customActive.toggle()
            if !entry.customActive {
                entry.customText = ""
            } else {
                customInputFocused = true
            }
        } else {
            entry.customActive.toggle()
            if entry.customActive {
                if question.customFieldName == nil {
                    entry.selected = []
                }
                customInputFocused = true
            } else {
                entry.customText = ""
            }
        }
        answers[question.id] = entry
    }
}

/// Inline timeline card matching VibeX desktop's `AskQuestionToolCard.tsx`:
/// displays the question title, `查看详情` toggle, `问答确认` tag, and read-only question options.
struct AskQuestionToolCardView: View {
    let tool: ToolStep
    @State private var isExpanded = false
    @State private var activeIndex = 0

    private var questions: [FormQuestion] { tool.questions }
    private var activeQuestion: FormQuestion? {
        guard !questions.isEmpty else { return nil }
        let idx = min(max(0, activeIndex), questions.count - 1)
        return questions[idx]
    }

    private var cardTitle: String {
        if let q = activeQuestion {
            return q.text.isEmpty ? q.header : q.text
        }
        return tool.preview ?? "需要确认的问题"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(cardTitle)
                .font(.system(size: 13.5, weight: .medium))
                .foregroundStyle(.primary)
                .lineLimit(isExpanded ? 3 : 1)

            HStack(spacing: 8) {
                if !questions.isEmpty {
                    Button {
                        withAnimation(.spring(response: 0.26, dampingFraction: 0.86)) {
                            isExpanded.toggle()
                        }
                    } label: {
                        HStack(spacing: 4) {
                            Image(systemName: "chevron.right")
                                .font(.system(size: 10, weight: .bold))
                                .rotationEffect(.degrees(isExpanded ? 90 : 0))
                            Text("查看详情")
                                .font(.system(size: 12, weight: .medium))
                        }
                        .foregroundStyle(.secondary)
                    }
                    .buttonStyle(.plain)
                }

                Spacer(minLength: 4)

                Text("问答确认")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 2)
                    .background(Color.primary.opacity(0.06), in: Capsule())
            }

            if isExpanded, let current = activeQuestion {
                Divider().opacity(0.45)

                VStack(alignment: .leading, spacing: 8) {
                    if questions.count > 1 {
                        HStack(spacing: 6) {
                            Text("\(activeIndex + 1) / \(questions.count)")
                                .font(.system(size: 11, weight: .semibold, design: .monospaced))
                                .foregroundStyle(.secondary)
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .background(Color.primary.opacity(0.06), in: Capsule())
                            Text(current.header)
                                .font(.system(size: 12.5, weight: .semibold))
                                .foregroundStyle(.primary)
                            Spacer()
                            HStack(spacing: 4) {
                                Button {
                                    activeIndex = max(0, activeIndex - 1)
                                } label: {
                                    Image(systemName: "chevron.left")
                                        .font(.system(size: 11, weight: .semibold))
                                        .frame(width: 24, height: 24)
                                }
                                .disabled(activeIndex == 0)
                                Button {
                                    activeIndex = min(questions.count - 1, activeIndex + 1)
                                } label: {
                                    Image(systemName: "chevron.right")
                                        .font(.system(size: 11, weight: .semibold))
                                        .frame(width: 24, height: 24)
                                }
                                .disabled(activeIndex >= questions.count - 1)
                            }
                            .buttonStyle(.plain)
                        }
                    }

                    ForEach(current.choices) { choice in
                        HStack(alignment: .top, spacing: 8) {
                            Circle()
                                .strokeBorder(Color.secondary.opacity(0.4), lineWidth: 1.2)
                                .frame(width: 14, height: 14)
                                .padding(.top, 2)
                            VStack(alignment: .leading, spacing: 2) {
                                HStack(spacing: 5) {
                                    Text(choice.label)
                                        .font(.system(size: 13))
                                        .foregroundStyle(.primary)
                                    if choice.recommended {
                                        Text("推荐")
                                            .font(.system(size: 10, weight: .semibold))
                                            .foregroundStyle(Color.accentColor)
                                            .padding(.horizontal, 5)
                                            .padding(.vertical, 1)
                                            .background(Color.accentColor.opacity(0.12), in: Capsule())
                                    }
                                }
                                if let desc = choice.description, !desc.isEmpty {
                                    Text(desc)
                                        .font(.system(size: 11.5))
                                        .foregroundStyle(.secondary)
                                }
                            }
                            Spacer(minLength: 0)
                        }
                        .padding(.horizontal, 10)
                        .padding(.vertical, 7)
                        .background(
                            RoundedRectangle(cornerRadius: 8, style: .continuous)
                                .fill(Color(.tertiarySystemGroupedBackground))
                        )
                    }
                }
                .padding(.top, 4)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
        .background(
            RoundedRectangle(cornerRadius: 11, style: .continuous)
                .fill(Color(.secondarySystemGroupedBackground))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 11, style: .continuous)
                .strokeBorder(Color.primary.opacity(0.08), lineWidth: 0.6)
        )
    }
}
