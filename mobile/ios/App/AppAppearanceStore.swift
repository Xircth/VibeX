import CompanionCore
import Observation
import QuartzCore
import SwiftUI
import UIKit
import UserNotifications

enum AppThemeMode: String, CaseIterable, Identifiable {
    case system
    case light
    case dark

    var id: String { rawValue }

    var title: String {
        switch self {
        case .system: return "跟随系统"
        case .light: return "浅色"
        case .dark: return "深色"
        }
    }

    var subtitle: String {
        switch self {
        case .system: return "自动跟随系统外观"
        case .light: return "明亮清爽浅色外观"
        case .dark: return "专注护眼深色外观"
        }
    }

    var icon: String {
        switch self {
        case .system: return "circle.lefthalf.filled"
        case .light: return "sun.max.fill"
        case .dark: return "moon.stars.fill"
        }
    }

    var colorScheme: ColorScheme? {
        switch self {
        case .system: return nil
        case .light: return .light
        case .dark: return .dark
        }
    }

    var uiInterfaceStyle: UIUserInterfaceStyle {
        switch self {
        case .system: return .unspecified
        case .light: return .light
        case .dark: return .dark
        }
    }
}

enum AppFontSizePreset: String, CaseIterable, Identifiable {
    case small
    case standard
    case mediumLarge
    case large
    case extraLarge

    var id: String { rawValue }

    var title: String {
        switch self {
        case .small: return "小"
        case .standard: return "标准"
        case .mediumLarge: return "中大"
        case .large: return "大"
        case .extraLarge: return "特大"
        }
    }

    var scaleLabel: String {
        switch self {
        case .small: return "90%"
        case .standard: return "100%"
        case .mediumLarge: return "110%"
        case .large: return "120%"
        case .extraLarge: return "135%"
        }
    }

    var pointPreviewSize: CGFloat {
        switch self {
        case .small: return 13.5
        case .standard: return 15.0
        case .mediumLarge: return 16.5
        case .large: return 18.0
        case .extraLarge: return 20.0
    }
    }

    var dynamicTypeSize: DynamicTypeSize {
        switch self {
        case .small: return .small
        case .standard: return .large
        case .mediumLarge: return .xLarge
        case .large: return .xxLarge
        case .extraLarge: return .xxxLarge
        }
    }
}

enum AppFontStylePreset: String, CaseIterable, Identifiable {
    case system
    case rounded
    case serif
    case monospaced

    var id: String { rawValue }

    var title: String {
        switch self {
        case .system: return "系统默认 (SF Pro / 苹方)"
        case .rounded: return "圆体 (SF Rounded)"
        case .serif: return "衬线 (New York / 宋体)"
        case .monospaced: return "等宽代码 (SF Mono)"
        }
    }

    var shortTitle: String {
        switch self {
        case .system: return "系统默认"
        case .rounded: return "圆体"
        case .serif: return "衬线"
        case .monospaced: return "等宽"
        }
    }

    var subtitle: String {
        switch self {
        case .system: return "清晰均衡的 Apple 原生无衬线字体"
        case .rounded: return "柔和现代的几何圆角字体"
        case .serif: return "适合长文阅读的经典衬线字体"
        case .monospaced: return "字符等宽对齐，适合代码与终端重度用户"
        }
    }

    var fontDesign: Font.Design {
        switch self {
        case .system: return .default
        case .rounded: return .rounded
        case .serif: return .serif
        case .monospaced: return .monospaced
        }
    }
}

@MainActor
@Observable
final class AppAppearanceStore {
    private let defaults: UserDefaults

    // 1. Profile
    var userName: String {
        didSet { defaults.set(userName, forKey: "vibex.profile.userName") }
    }
    var userHandle: String {
        didSet { defaults.set(userHandle, forKey: "vibex.profile.userHandle") }
    }
    var userRoleTitle: String {
        didSet { defaults.set(userRoleTitle, forKey: "vibex.profile.userRoleTitle") }
    }
    var userBio: String {
        didSet { defaults.set(userBio, forKey: "vibex.profile.userBio") }
    }
    var userAvatarJSON: String {
        didSet { defaults.set(userAvatarJSON, forKey: "vibex.profile.userAvatarJSON") }
    }

    // 2. Theme
    var themeMode: AppThemeMode {
        didSet { defaults.set(themeMode.rawValue, forKey: "vibex.appearance.themeMode") }
    }

    // 3. Font
    var fontSizePreset: AppFontSizePreset {
        didSet { defaults.set(fontSizePreset.rawValue, forKey: "vibex.appearance.fontSize") }
    }
    var fontStylePreset: AppFontStylePreset {
        didSet { defaults.set(fontStylePreset.rawValue, forKey: "vibex.appearance.fontStyle") }
    }

    // 4. Notifications
    var notifyTurnCompleted: Bool {
        didSet { defaults.set(notifyTurnCompleted, forKey: "vibex.notify.turnCompleted") }
    }
    var notifyApprovalRequired: Bool {
        didSet { defaults.set(notifyApprovalRequired, forKey: "vibex.notify.approvalRequired") }
    }
    var notifyCollabMessages: Bool {
        didSet { defaults.set(notifyCollabMessages, forKey: "vibex.notify.collabMessages") }
    }
    var notificationSound: Bool {
        didSet { defaults.set(notificationSound, forKey: "vibex.notify.sound") }
    }
    var hapticFeedback: Bool {
        didSet { defaults.set(hapticFeedback, forKey: "vibex.notify.haptic") }
    }
    var systemNotificationStatusText: String = "已启用"

    private weak var activeOverlayView: UIView?

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        self.userName = defaults.string(forKey: "vibex.profile.userName") ?? "LTF"
        self.userHandle = defaults.string(forKey: "vibex.profile.userHandle") ?? "@ltf"
        self.userRoleTitle = defaults.string(forKey: "vibex.profile.userRoleTitle") ?? "VibeX Creator"
        self.userBio = defaults.string(forKey: "vibex.profile.userBio") ?? "本地优先 AI 协同工作流与多智能体架构"
        self.userAvatarJSON =
            defaults.string(forKey: "vibex.profile.userAvatarJSON")
            ?? CollabBotAvatarConfig(color: "#1584ff", shape: .cloud).jsonString

        let rawTheme = defaults.string(forKey: "vibex.appearance.themeMode") ?? AppThemeMode.system.rawValue
        self.themeMode = AppThemeMode(rawValue: rawTheme) ?? .system

        let rawSize = defaults.string(forKey: "vibex.appearance.fontSize") ?? AppFontSizePreset.standard.rawValue
        self.fontSizePreset = AppFontSizePreset(rawValue: rawSize) ?? .standard

        let rawStyle = defaults.string(forKey: "vibex.appearance.fontStyle") ?? AppFontStylePreset.system.rawValue
        self.fontStylePreset = AppFontStylePreset(rawValue: rawStyle) ?? .system

        self.notifyTurnCompleted = defaults.object(forKey: "vibex.notify.turnCompleted") as? Bool ?? true
        self.notifyApprovalRequired = defaults.object(forKey: "vibex.notify.approvalRequired") as? Bool ?? true
        self.notifyCollabMessages = defaults.object(forKey: "vibex.notify.collabMessages") as? Bool ?? true
        self.notificationSound = defaults.object(forKey: "vibex.notify.sound") as? Bool ?? true
        self.hapticFeedback = defaults.object(forKey: "vibex.notify.haptic") as? Bool ?? true

        Task {
            applyInterfaceStyleToAllWindows(themeMode.uiInterfaceStyle)
            await refreshNotificationAuthorizationStatus()
        }
    }

    var avatarConfig: CollabBotAvatarConfig {
        get {
            CollabBotAvatarConfig.resolve(
                rawAvatar: userAvatarJSON,
                rawColor: nil,
                fallbackSeed: userName
            )
        }
        set { userAvatarJSON = newValue.jsonString }
    }

    /// Switches the theme and animates a CoreAnimation circular reveal expanding from the top-right corner (`右上角展开`).
    func setThemeModeWithTopRightReveal(_ newMode: AppThemeMode) {
        guard newMode != themeMode else { return }

        if hapticFeedback {
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
        }

        guard let window = Self.keyWindow() else {
            themeMode = newMode
            return
        }

        // Remove any previous in-flight overlay
        activeOverlayView?.removeFromSuperview()

        // 1. Snapshot the OLD appearance before switching
        let renderer = UIGraphicsImageRenderer(bounds: window.bounds)
        let oldSnapshot = renderer.image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: false)
        }

        // 2. Place the OLD snapshot on top of the window so the screen stays visually stable
        let overlay = UIImageView(image: oldSnapshot)
        overlay.frame = window.bounds
        overlay.contentMode = .scaleToFill
        overlay.isUserInteractionEnabled = false
        window.addSubview(overlay)
        activeOverlayView = overlay

        // 3. Switch the underlying live window & SwiftUI hierarchy to the NEW theme immediately
        themeMode = newMode
        applyInterfaceStyleToAllWindows(newMode.uiInterfaceStyle)

        // 4. Cut out an expanding circle starting from the TOP-RIGHT corner (`CGPoint(x: width - 34, y: 68)`)
        //    on the old snapshot using an Even-Odd CAShapeLayer mask + CABasicAnimation on the GPU render server!
        let bounds = window.bounds
        let topRightOrigin = CGPoint(
            x: bounds.maxX - 34,
            y: max(window.safeAreaInsets.top + 20, 64)
        )
        let startRadius: CGFloat = 1.0
        let maxRadius: CGFloat = hypot(bounds.width, bounds.height) * 1.08

        let startCircleRect = CGRect(
            x: topRightOrigin.x - startRadius,
            y: topRightOrigin.y - startRadius,
            width: startRadius * 2,
            height: startRadius * 2
        )
        let endCircleRect = CGRect(
            x: topRightOrigin.x - maxRadius,
            y: topRightOrigin.y - maxRadius,
            width: maxRadius * 2,
            height: maxRadius * 2
        )

        let startMaskPath = UIBezierPath(rect: bounds)
        startMaskPath.append(UIBezierPath(ovalIn: startCircleRect))

        let endMaskPath = UIBezierPath(rect: bounds)
        endMaskPath.append(UIBezierPath(ovalIn: endCircleRect))

        let maskLayer = CAShapeLayer()
        maskLayer.fillRule = .evenOdd
        maskLayer.path = endMaskPath.cgPath
        overlay.layer.mask = maskLayer

        // Subtle expanding wave ring from the top-right corner
        let ringLayer = CAShapeLayer()
        ringLayer.fillColor = UIColor.clear.cgColor
        ringLayer.strokeColor = UIColor.systemBlue.withAlphaComponent(0.45).cgColor
        ringLayer.lineWidth = 2.0
        ringLayer.path = UIBezierPath(ovalIn: endCircleRect).cgPath
        window.layer.addSublayer(ringLayer)

        let duration: CFTimeInterval = 0.56
        let timing = CAMediaTimingFunction(controlPoints: 0.22, 1.0, 0.36, 1.0)

        let maskAnim = CABasicAnimation(keyPath: "path")
        maskAnim.fromValue = startMaskPath.cgPath
        maskAnim.toValue = endMaskPath.cgPath
        maskAnim.duration = duration
        maskAnim.timingFunction = timing
        maskAnim.fillMode = .forwards
        maskLayer.add(maskAnim, forKey: "topRightCircularReveal")

        let ringAnim = CABasicAnimation(keyPath: "path")
        ringAnim.fromValue = UIBezierPath(ovalIn: startCircleRect).cgPath
        ringAnim.toValue = UIBezierPath(ovalIn: endCircleRect).cgPath
        ringAnim.duration = duration
        ringAnim.timingFunction = timing
        ringLayer.add(ringAnim, forKey: "topRightRingExpand")

        let ringFade = CABasicAnimation(keyPath: "opacity")
        ringFade.fromValue = 1.0
        ringFade.toValue = 0.0
        ringFade.duration = duration
        ringFade.timingFunction = CAMediaTimingFunction(name: .easeIn)
        ringLayer.opacity = 0.0
        ringLayer.add(ringFade, forKey: "topRightRingFade")

        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(580))
            if self.activeOverlayView === overlay {
                overlay.removeFromSuperview()
                self.activeOverlayView = nil
            }
            ringLayer.removeFromSuperlayer()
        }
    }

    func applyInterfaceStyleToAllWindows(_ style: UIUserInterfaceStyle) {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        for scene in scenes {
            for window in scene.windows {
                window.overrideUserInterfaceStyle = style
            }
        }
    }

    func refreshNotificationAuthorizationStatus() async {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        switch settings.authorizationStatus {
        case .authorized, .provisional, .ephemeral:
            systemNotificationStatusText = "系统通知已开启"
        case .denied:
            systemNotificationStatusText = "系统通知已关闭"
        case .notDetermined:
            systemNotificationStatusText = "待授权"
        @unknown default:
            systemNotificationStatusText = "未知"
        }
    }

    func requestSystemNotificationPermission() async {
        _ = try? await UNUserNotificationCenter.current().requestAuthorization(
            options: [.alert, .badge, .sound]
        )
        await refreshNotificationAuthorizationStatus()
    }

    private static func keyWindow() -> UIWindow? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        return scenes.flatMap(\.windows).first(where: \.isKeyWindow)
            ?? scenes.flatMap(\.windows).first
    }
}
