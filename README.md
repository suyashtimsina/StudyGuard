# StudyGuard 📚

**Stay focused. Study smarter.**

StudyGuard is a browser-based study productivity application that combines a Pomodoro timer with camera-based focus detection to help students maintain concentration during study sessions.

## ✨ Features

- **Pomodoro Timer:** Study in 25-minute focus sessions with short breaks and longer breaks after every fourth session.
- **Smart Focus Detection:** Uses your camera to detect when you are looking away or holding a phone.
- **Calibration:** Calibrates focus detection to your normal face position and seating angle.
- **Gentle Reminders:** Provides sound alerts, voice prompts, and on-screen notifications when distractions are detected.
- **Study Statistics:** Tracks your daily Pomodoro sessions and study progress.
- **Customizable Settings:** Adjust timer durations and other preferences.
- **Privacy Focused:** Camera processing runs locally in your browser. The camera turns off when you stop studying.

## 🛠️ Technologies Used

- HTML5
- CSS3
- JavaScript (ES Modules)
- MediaPipe Tasks Vision
- Browser APIs (Camera, Notifications, Local Storage)

## 📁 Project Structure

```text
StudyGuard/
│
├── index.html
│
├── css/
│   └── styles.css
│
└── js/
    └── app.js
```

## 🚀 Getting Started

### 1. Clone the repository

```bash
git clone https://github.com/suyashtimsina/StudyGuard.git
```

### 2. Open the project

```bash
cd StudyGuard
```

### 3. Run the application

Open the project in VS Code and launch `index.html` using the **Live Server** extension.

You can also use Python's local server:

```bash
python -m http.server 8000
```

Then visit:

```text
http://localhost:8000
```

### 4. Allow camera access

When prompted, grant camera permission to enable smart focus detection. Keep your browser open while using a study session.

## 🔒 Privacy

- Camera access is used for real-time focus detection.
- Camera processing takes place in the browser.
- The camera stops when you end your study session.
- Study settings and daily statistics are stored using browser Local Storage.

## 🎯 Project Goal

The goal of StudyGuard is to make studying more productive by combining time management and distraction awareness in one simple application.

---

**Built with the goal of helping students stay focused and study smarter.**