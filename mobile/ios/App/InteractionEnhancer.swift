import SwiftUI
import UIKit

extension Notification.Name {
    static let vibexTapOutsideInput = Notification.Name("vibex.tapOutsideInput")
}

@MainActor
func dismissKeyboard() {
    UIApplication.shared.sendAction(
        #selector(UIResponder.resignFirstResponder),
        to: nil,
        from: nil,
        for: nil
    )
}

/// Window-level interaction enhancer that:
/// 1. Dismisses the keyboard and notifies active search bars when tapping any blank / non-input area.
/// 2. Keeps interactive pop gesture (edge swipe to go back) enabled across NavigationStacks.
struct GlobalInteractionInstaller: UIViewRepresentable {
    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeUIView(context: Context) -> InstallerView {
        let view = InstallerView()
        view.coordinator = context.coordinator
        return view
    }

    func updateUIView(_ uiView: InstallerView, context: Context) {
        uiView.coordinator = context.coordinator
        uiView.installIfNeeded()
    }

    final class InstallerView: UIView {
        weak var coordinator: Coordinator?

        override func didMoveToWindow() {
            super.didMoveToWindow()
            installIfNeeded()
        }

        func installIfNeeded() {
            guard let window else { return }
            coordinator?.attach(to: window)
        }
    }

    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        private weak var attachedWindow: UIWindow?
        private var tapRecognizer: UITapGestureRecognizer?

        func attach(to window: UIWindow) {
            if attachedWindow === window, tapRecognizer != nil {
                enableInteractivePopInHierarchy(from: window.rootViewController)
                return
            }

            if let oldTap = tapRecognizer, let oldWindow = attachedWindow {
                oldWindow.removeGestureRecognizer(oldTap)
            }

            let tap = UITapGestureRecognizer(target: self, action: #selector(handleWindowTap(_:)))
            tap.cancelsTouchesInView = false
            tap.delaysTouchesBegan = false
            tap.delaysTouchesEnded = false
            tap.delegate = self
            window.addGestureRecognizer(tap)

            self.attachedWindow = window
            self.tapRecognizer = tap
            enableInteractivePopInHierarchy(from: window.rootViewController)
        }

        @objc private func handleWindowTap(_ recognizer: UITapGestureRecognizer) {
            guard recognizer.state == .ended, let window = attachedWindow else { return }
            let location = recognizer.location(in: window)
            let hitView = window.hitTest(location, with: nil)
            let insideTextInput = Self.isInsideTextInput(hitView)

            NotificationCenter.default.post(
                name: .vibexTapOutsideInput,
                object: nil,
                userInfo: [
                    "location": NSValue(cgPoint: location),
                    "insideTextInput": insideTextInput,
                ]
            )

            if !insideTextInput {
                window.endEditing(true)
            }

            enableInteractivePopInHierarchy(from: window.rootViewController)
        }

        func gestureRecognizer(
            _ gestureRecognizer: UIGestureRecognizer,
            shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer
        ) -> Bool {
            true
        }

        private static func isInsideTextInput(_ view: UIView?) -> Bool {
            var current = view
            while let v = current {
                if v is UITextField || v is UITextView {
                    return true
                }
                let typeName = String(describing: type(of: v))
                if typeName.contains("TextField") || typeName.contains("SearchBar") {
                    return true
                }
                current = v.superview
            }
            return false
        }

        private func enableInteractivePopInHierarchy(from root: UIViewController?) {
            guard let root else { return }
            if let nav = root as? UINavigationController {
                nav.interactivePopGestureRecognizer?.isEnabled = true
                if nav.viewControllers.count > 1 {
                    nav.interactivePopGestureRecognizer?.delegate = nil
                }
            }
            for child in root.children {
                enableInteractivePopInHierarchy(from: child)
            }
            if let presented = root.presentedViewController {
                enableInteractivePopInHierarchy(from: presented)
            }
        }
    }
}
