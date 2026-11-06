import CompanionCore
import SwiftUI

/// Human-in-the-loop question card: one question at a time, the stack slides between them, single-choice
/// answers advance on their own and multi-select waits for Continue.
struct ApprovalCard: View {
    let request: PendingQuestion
    let submit: (JSONValue?) async -> Void

    private let questions: [FormQuestion]
    @State private var index = 0
    @State private var answers: [String: QuestionAnswer] = [:]
    @State private var sent = false
    @State private var pendingAdvance: Task<Void, Never>?

    init(request: PendingQuestion, submit: @escaping (JSONValue?) async -> Void) {
        self.request = request
        self.submit = submit
        self.questions = QuestionForm.questions(for: request)
    }

    private var question: FormQuestion { questions[index] }
    private var isLast: Bool { index == questions.count - 1 }
    private var answer: QuestionAnswer { answers[question.id] ?? QuestionAnswer() }

    var body: some View {
        if sent {
            Label("答案已发送", systemImage: "checkmark.circle.fill")
                .font(.system(size: 12.5, weight: .medium))
                .foregroundStyle(.green)
                .padding(.vertical, 6)
                .padding(.horizontal, 10)
                .background(Color.green.opacity(0.12), in: Capsule())
                .transition(.scale(scale: 0.95).combined(with: .opacity))
        } else {
            card
                .transition(.move(edge: .bottom).combined(with: .opacity))
        }
    }

    private var card: some View {
        VStack(spacing: 0) {
            ZStack(alignment: .topLeading) {
                questionView
                    .id(index)
                    .transition(.asymmetric(
                        insertion: .move(edge: .bottom).combined(with: .opacity),
                        removal: .move(edge: .top).combined(with: .opacity)
                    ))
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .clipped()
            footer
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
        }
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(Color.primary.opacity(0.06)))
        .shadow(color: .black.opacity(0.06), radius: 8, y: 2)
        .animation(.timingCurve(0.22, 1, 0.36, 1, duration: 0.36), value: index)
        .onDisappear { pendingAdvance?.cancel() }
    }

    private var questionView: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(question.text).font(.system(size: 14, weight: .medium))
            VStack(alignment: .leading, spacing: 2) {
                ForEach(question.choices) { choice in optionRow(choice) }
                TextField("其他…", text: customText)
                    .font(.system(size: 13))
                    .padding(.vertical, 6)
                    .padding(.leading, 22)
                    .submitLabel(.send)
                    .onSubmit { if !answer.isEmpty { advance() } }
            }
        }
    }

    private func optionRow(_ choice: QuestionChoice) -> some View {
        let on = answer.selected.contains(choice.value)
        return Button {
            toggle(choice)
        } label: {
            HStack(alignment: .top, spacing: 8) {
                indicator(on: on)
                VStack(alignment: .leading, spacing: 1) {
                    Text(choice.label)
                        .font(.system(size: 13))
                        .foregroundStyle(on ? Color.primary : Color.primary.opacity(0.7))
                    if let description = choice.description, !description.isEmpty {
                        Text(description).font(.system(size: 11)).foregroundStyle(.secondary)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(.vertical, 6)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(on ? .isSelected : [])
    }

    private func indicator(on: Bool) -> some View {
        ZStack {
            if question.multiSelect {
                RoundedRectangle(cornerRadius: 5)
                    .fill(on ? Color.primary : .clear)
                    .overlay(RoundedRectangle(cornerRadius: 5).stroke(Color.primary.opacity(on ? 0 : 0.3), lineWidth: 1.5))
                if on { Image(systemName: "checkmark").font(.system(size: 9, weight: .heavy)).foregroundStyle(Color(.systemBackground)) }
            } else {
                Circle()
                    .fill(on ? Color.primary : .clear)
                    .overlay(Circle().stroke(Color.primary.opacity(on ? 0 : 0.3), lineWidth: 1.5))
                Circle().fill(Color(.systemBackground)).frame(width: 6, height: 6).scaleEffect(on ? 1 : 0)
            }
        }
        .frame(width: 16, height: 16)
        .animation(.easeOut(duration: 0.2), value: on)
    }

    private var footer: some View {
        HStack(spacing: 10) {
            HStack(spacing: 4) {
                navButton("chevron.up", enabled: index > 0) { go(index - 1) }
                Text("\(index + 1) / \(questions.count)")
                    .font(.system(size: 12, weight: .medium))
                    .monospacedDigit()
                    .foregroundStyle(.tertiary)
                    .contentTransition(.numericText())
                navButton("chevron.down", enabled: !isLast) { go(index + 1) }
            }
            Spacer()
            Button("跳过") { advance() }
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(.secondary)
                .buttonStyle(.plain)
                .padding(.horizontal, 8)
            Button(action: advance) {
                HStack(spacing: 6) {
                    Text(isLast ? "发送" : "继续")
                    Image(systemName: "return").font(.system(size: 10, weight: .semibold))
                }
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(Color(.systemBackground))
                .padding(.horizontal, 14)
                .padding(.vertical, 6)
                .background(Color.primary.opacity(answer.isEmpty ? 0.25 : 1), in: Capsule())
            }
            .buttonStyle(.plain)
            .disabled(answer.isEmpty)
        }
    }

    private func navButton(_ symbol: String, enabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(.secondary)
                .frame(width: 22, height: 22)
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.3)
    }

    private var customText: Binding<String> {
        Binding(
            get: { answer.customText },
            set: { text in
                var next = answer
                next.customText = text
                if !question.multiSelect, !text.isEmpty { next.selected = [] }
                answers[question.id] = next
            }
        )
    }

    private func toggle(_ choice: QuestionChoice) {
        var next = answer
        if question.multiSelect {
            if let at = next.selected.firstIndex(of: choice.value) {
                next.selected.remove(at: at)
            } else {
                next.selected.append(choice.value)
            }
        } else {
            next.selected = [choice.value]
            next.customText = ""
        }
        answers[question.id] = next
        pendingAdvance?.cancel()
        guard !question.multiSelect else { return }
        pendingAdvance = Task {
            try? await Task.sleep(for: .milliseconds(480))
            guard !Task.isCancelled else { return }
            await MainActor.run { advance() }
        }
    }

    private func go(_ target: Int) {
        pendingAdvance?.cancel()
        index = min(max(target, 0), questions.count - 1)
    }

    private func advance() {
        pendingAdvance?.cancel()
        if isLast {
            withAnimation { sent = true }
            let content = QuestionForm.content(for: request, questions: questions, answers: answers)
            Task { await submit(content) }
        } else {
            index += 1
        }
    }
}
