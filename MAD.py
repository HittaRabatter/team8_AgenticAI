#!/usr/bin/env python3
"""Volvo MAD priority machine risk dashboard."""

from __future__ import annotations

import importlib.util
import json
import shutil
import sys
from pathlib import Path
from typing import Any

from PySide6.QtCore import QProcess, QRectF, Qt
from PySide6.QtGui import QColor, QPainter, QPen, QPixmap
from PySide6.QtWidgets import QApplication, QDialog, QFrame, QHBoxLayout, QLabel, QMainWindow, QMessageBox, QPlainTextEdit, QPushButton, QVBoxLayout, QWidget

BASE_DIR = Path(__file__).resolve().parent
FUNCTION_FILE = BASE_DIR / "team8-challenge0-machineFunction.py"
LOGO_FILE = BASE_DIR / "Volvo_MAD.png"
TRUCK_FILE = BASE_DIR / "A40_BEV.png"
PRIORITY_ISSUE_ID = "telemetry-001-20241201-143022"
COPILOT_AGENT = "MaoWeiAgent"


def load_machine_module():
    spec = importlib.util.spec_from_file_location("machine_function", FUNCTION_FILE)
    if spec is None or spec.loader is None:
        raise ImportError(f"Could not load {FUNCTION_FILE}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class RiskSection(QFrame):
    def __init__(self, title: str, content: str, color: str) -> None:
        super().__init__()
        self.setStyleSheet(f"QFrame {{ background: {color}; border: 1px solid #c5d2d5; border-radius: 6px; }}")
        layout = QVBoxLayout(self)
        heading = QLabel(title)
        heading.setStyleSheet("color: #0b3d4f; font-size: 13px; font-weight: bold; border: none;")
        layout.addWidget(heading)
        body = QPlainTextEdit(content)
        body.setReadOnly(True)
        body.setStyleSheet(f"background: {color}; color: #20343a; border: none; font-family: Segoe UI; font-size: 12px;")
        layout.addWidget(body)


class TruckImage(QWidget):
    """Display the A40 image and mark its large right-side tire in red."""

    def __init__(self) -> None:
        super().__init__()
        self.pixmap = QPixmap(str(TRUCK_FILE))
        self.setMinimumSize(480, 360)

    def paintEvent(self, _event) -> None:
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)
        painter.fillRect(self.rect(), QColor("#ffffff"))
        if self.pixmap.isNull():
            painter.setPen(QColor("#7d3028"))
            painter.drawText(self.rect(), Qt.AlignmentFlag.AlignCenter, f"Image not found: {TRUCK_FILE.name}")
            return

        scaled = self.pixmap.scaled(self.size(), Qt.AspectRatioMode.KeepAspectRatio, Qt.TransformationMode.SmoothTransformation)
        left = (self.width() - scaled.width()) / 2
        top = (self.height() - scaled.height()) / 2
        painter.drawPixmap(int(left), int(top), scaled)

        tire_box = QRectF(
            left + scaled.width() * 0.715,
            top + scaled.height() * 0.605,
            scaled.width() * 0.255,
            scaled.height() * 0.365,
        )
        painter.setPen(QPen(QColor("#e1251b"), 7))
        painter.setBrush(Qt.BrushStyle.NoBrush)
        painter.drawEllipse(tire_box)
        painter.setPen(QPen(QColor("#e1251b"), 2))
        painter.drawText(tire_box.adjusted(0, -32, 0, 0), Qt.AlignmentFlag.AlignTop | Qt.AlignmentFlag.AlignHCenter, "TIRE RISK AREA")


class MaoWeiChatDialog(QDialog):
    def __init__(self, analysis: dict[str, Any] | None, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.analysis = analysis
        self.process: QProcess | None = None
        self.history: list[tuple[str, str]] = []
        self.setWindowTitle("Chat with MaoWeiAgent")
        self.resize(720, 620)

        layout = QVBoxLayout(self)
        heading = QLabel("MaoWeiAgent - anomaly detection")
        heading.setStyleSheet("color: #0b3d4f; font-size: 18px; font-weight: bold;")
        layout.addWidget(heading)

        self.transcript = QPlainTextEdit()
        self.transcript.setReadOnly(True)
        self.transcript.setPlaceholderText("Ask about machine telemetry, anomaly evidence, risk, or next actions.")
        self.transcript.setStyleSheet("background: #f7fafb; color: #20343a; border: 1px solid #bfd0d4; padding: 8px;")
        layout.addWidget(self.transcript, 1)

        self.message = QPlainTextEdit()
        self.message.setPlaceholderText("Message MaoWeiAgent...")
        self.message.setMaximumHeight(100)
        layout.addWidget(self.message)

        actions = QHBoxLayout()
        actions.addStretch()
        self.send_button = QPushButton("Send")
        self.send_button.setDefault(True)
        self.send_button.setStyleSheet("QPushButton { background: #0b3d4f; color: white; border: none; border-radius: 4px; padding: 10px 24px; font-weight: bold; } QPushButton:disabled { background: #8ca0a6; }")
        self.send_button.clicked.connect(self.send_message)
        actions.addWidget(self.send_button)
        layout.addLayout(actions)

    def send_message(self) -> None:
        user_message = self.message.toPlainText().strip()
        if not user_message or self.process is not None:
            return

        copilot = shutil.which("copilot")
        if not copilot:
            QMessageBox.warning(
                self,
                "Copilot CLI not found",
                "Install GitHub Copilot CLI and run 'copilot login', then reopen Volvo MAD.",
            )
            return

        self.message.clear()
        self.transcript.appendPlainText(f"You:\n{user_message}\n")
        self.send_button.setEnabled(False)
        self.send_button.setText("Thinking...")

        prompt = self._build_prompt(user_message)
        self.process = QProcess(self)
        self.process.setWorkingDirectory(str(BASE_DIR))
        self.process.setProgram(copilot)
        self.process.setArguments([
            "--agent", COPILOT_AGENT,
            "--prompt", prompt,
            "--silent",
            "--allow-all-tools",
            "--trust-folder",
            "--no-color",
        ])
        self.process.finished.connect(self._agent_finished)
        self.process.errorOccurred.connect(self._agent_error)
        self.process.start()

    def _build_prompt(self, user_message: str) -> str:
        context: dict[str, Any] = {}
        if self.analysis:
            context = {
                "machine": self.analysis.get("machine"),
                "latestTelemetry": self.analysis.get("latest"),
                "thresholdViolations": self.analysis.get("anomalies"),
                "severity": self.analysis.get("severity"),
                "warningCount": self.analysis.get("warning_count"),
                "criticalCount": self.analysis.get("critical_count"),
            }
        recent_history = self.history[-6:]
        return (
            "Answer as MaoWeiAgent. Use the current dashboard context and recent conversation below. "
            "Do not edit files or run commands.\n\n"
            f"Dashboard context:\n{json.dumps(context, indent=2, default=str)}\n\n"
            f"Recent conversation:\n{json.dumps(recent_history, indent=2)}\n\n"
            f"User message:\n{user_message}"
        )

    def _agent_finished(self, exit_code: int, _exit_status: QProcess.ExitStatus) -> None:
        if self.process is None:
            return
        response = bytes(self.process.readAllStandardOutput()).decode(errors="replace").strip()
        error = bytes(self.process.readAllStandardError()).decode(errors="replace").strip()
        user_message = self.transcript.toPlainText().rsplit("You:\n", 1)[-1].strip()
        if exit_code == 0 and response:
            self.transcript.appendPlainText(f"MaoWeiAgent:\n{response}\n")
            self.history.append((user_message, response))
        else:
            details = error or response or f"Copilot CLI exited with code {exit_code}."
            self.transcript.appendPlainText(f"MaoWeiAgent error:\n{details}\n")
        self.process.deleteLater()
        self.process = None
        self.send_button.setEnabled(True)
        self.send_button.setText("Send")

    def _agent_error(self, _error: QProcess.ProcessError) -> None:
        if self.process is not None and self.process.state() == QProcess.ProcessState.NotRunning:
            self.transcript.appendPlainText(f"MaoWeiAgent error:\n{self.process.errorString()}\n")
            self.process.deleteLater()
            self.process = None
            self.send_button.setEnabled(True)
            self.send_button.setText("Send")


class VolvoMAD(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("Volvo MAD")
        self.resize(1120, 900)
        self.setMinimumSize(820, 720)
        self.machine_module = load_machine_module()
        self.analysis: dict[str, Any] | None = None
        self.chat_dialog: MaoWeiChatDialog | None = None
        self._build_ui()
        self.show_priority_case("001")

    def _build_ui(self) -> None:
        root = QWidget()
        root.setStyleSheet("background: #e8eef2;")
        self.setCentralWidget(root)
        outer = QVBoxLayout(root)
        outer.setContentsMargins(20, 18, 20, 20)
        outer.setSpacing(14)

        header = QFrame()
        header.setStyleSheet("background: #0b3d4f; border-radius: 6px;")
        header.setMinimumHeight(350)
        header_layout = QVBoxLayout(header)
        header_layout.setContentsMargins(20, 10, 20, 10)
        logo = QLabel()
        logo.setAlignment(Qt.AlignmentFlag.AlignCenter)
        pixmap = QPixmap(str(LOGO_FILE))
        if pixmap.isNull():
            logo.setText(f"Logo image not found: {LOGO_FILE.name}")
            logo.setStyleSheet("color: white; font-size: 18px;")
        else:
            logo.setPixmap(pixmap.scaled(600, 338, Qt.AspectRatioMode.KeepAspectRatio, Qt.TransformationMode.SmoothTransformation))
        header_layout.addWidget(logo, alignment=Qt.AlignmentFlag.AlignCenter)
        outer.addWidget(header)

        case = QFrame()
        case.setStyleSheet("QFrame { background: white; border: 1px solid #bfd0d4; border-radius: 6px; }")
        case_layout = QVBoxLayout(case)
        case_layout.setContentsMargins(18, 16, 18, 16)
        case_title = QLabel("priority machine case")
        case_title.setStyleSheet("color: #0b3d4f; font-size: 19px; font-weight: bold; border: none;")
        case_layout.addWidget(case_title)
        self.case_summary = QLabel()
        self.case_summary.setStyleSheet("color: #49636b; font-size: 12px; border: none;")
        case_layout.addWidget(self.case_summary)
        chat_button = QPushButton("Chat with MaoWeiAgent")
        chat_button.setCursor(Qt.CursorShape.PointingHandCursor)
        chat_button.setStyleSheet("QPushButton { background: #e1251b; color: white; border: none; border-radius: 4px; padding: 10px; font-size: 12px; font-weight: bold; } QPushButton:hover { background: #b91f17; }")
        chat_button.clicked.connect(self.open_maowei_chat)
        case_layout.addWidget(chat_button, alignment=Qt.AlignmentFlag.AlignRight)
        outer.addWidget(case)

        content = QHBoxLayout()
        content.setSpacing(14)

        risk_box = QFrame()
        risk_box.setStyleSheet("QFrame { background: #f8e4e0; border: 1px solid #dcbab3; border-radius: 6px; }")
        risk_box.setMaximumWidth(410)
        risk_layout = QVBoxLayout(risk_box)
        risk_layout.setContentsMargins(20, 18, 20, 20)
        risk_title = QLabel("RISK RATING")
        risk_title.setStyleSheet("color: #7d3028; font-size: 14px; font-weight: bold; border: none;")
        risk_layout.addWidget(risk_title)
        self.rating = QLabel()
        self.rating.setStyleSheet("color: #a63e31; font-size: 31px; font-weight: bold; border: none;")
        risk_layout.addWidget(self.rating)
        sections = QVBoxLayout()
        sections.setSpacing(14)
        self.risk_description = RiskSection("Risk text description", "", "#fff8f6")
        self.impact_analysis = RiskSection("Impact analysis", "", "#fff8f6")
        self.probability_score = RiskSection("Probability score", "", "#fff8f6")
        sections.addWidget(self.risk_description)
        sections.addWidget(self.impact_analysis)
        sections.addWidget(self.probability_score)
        risk_layout.addLayout(sections, 1)
        description_button = QPushButton("Generate text description")
        description_button.setCursor(Qt.CursorShape.PointingHandCursor)
        description_button.setStyleSheet("QPushButton { background: #0b3d4f; color: white; border: none; border-radius: 4px; padding: 11px; font-size: 12px; font-weight: bold; } QPushButton:hover { background: #14576d; }")
        description_button.clicked.connect(self.show_text_description)
        risk_layout.addWidget(description_button)
        content.addWidget(risk_box, 2)

        image_box = QFrame()
        image_box.setStyleSheet("QFrame { background: white; border: 1px solid #bfd0d4; border-radius: 6px; }")
        image_layout = QVBoxLayout(image_box)
        image_title = QLabel("A40 BEV - AFFECTED TIRE")
        image_title.setStyleSheet("color: #0b3d4f; font-size: 14px; font-weight: bold; border: none;")
        image_layout.addWidget(image_title)
        image_layout.addWidget(TruckImage(), 1)
        content.addWidget(image_box, 3)
        outer.addLayout(content, 1)

    def open_maowei_chat(self) -> None:
        self.chat_dialog = MaoWeiChatDialog(self.analysis, self)
        self.chat_dialog.show()

    def show_priority_case(self, machine_number: str) -> None:
        try:
            analysis: dict[str, Any] = self.machine_module.get_machine_analysis(machine_number)
        except (ValueError, FileNotFoundError) as error:
            self.case_summary.setText(str(error))
            return

        self.analysis = analysis
        machine = analysis["machine"]
        latest = analysis["latest"]
        anomalies = analysis["anomalies"]
        severity = analysis["severity"]
        score = 90 if severity == "critical" else 64 if severity == "warning" else 18
        probability = 0.88 if severity == "critical" else 0.64 if severity == "warning" else 0.18
        self.case_summary.setText(f"{machine['id']}  |  {machine['name']}  |  {machine.get('location', '')}  |  Latest telemetry: {latest['timestamp']}")
        self.rating.setText(f"{severity.upper()}  ·  {score}/100")
        anomaly_names = ", ".join(row[0] for row in anomalies) or "No threshold violations"
        self.risk_description.findChild(QPlainTextEdit).setPlainText(
            f"The latest telemetry indicates {severity} operating risk.\n\nAffected signals: {anomaly_names}.\n\nRecommended response: investigate the deviation and schedule maintenance."
        )
        self.impact_analysis.findChild(QPlainTextEdit).setPlainText(
            f"Production impact: {'High' if severity == 'critical' else 'Medium' if severity == 'warning' else 'Low'}\n\nWarning violations: {analysis['warning_count']}\nCritical violations: {analysis['critical_count']}\n\nA delayed response may affect equipment availability and product quality."
        )
        self.probability_score.findChild(QPlainTextEdit).setPlainText(
            f"Predicted anomaly risk: {probability:.0%}\n\nConfidence in rating: {'96%' if anomalies else '82%'}\n\nCriticality: {'Immediate attention' if severity == 'critical' else 'Plan maintenance soon' if severity == 'warning' else 'Routine monitoring'}"
        )

    def show_text_description(self) -> None:
        if not self.analysis:
            return
        telemetry = self.analysis["telemetry"]
        issue = next((item for item in telemetry if item.get("id") == PRIORITY_ISSUE_ID), None)
        later = sorted((item for item in telemetry if item.get("timestamp", "") > issue.get("timestamp", "")), key=lambda item: item["timestamp"])[0] if issue else None
        if not issue:
            description = f"Issue {PRIORITY_ISSUE_ID} was not found in the telemetry data."
        else:
            metrics = issue["metrics"]
            description = (
                f"Telemetry Analysis: Machine 001\n\n"
                f"Issue ID {issue['id']} is a normal baseline reading captured at {issue['timestamp']}. "
                f"The curing temperature was {metrics['curing_temperature']} C, curing pressure was "
                f"{metrics['curing_pressure']} bar, and cycle time was {metrics['cycle_time']} minutes. "
                f"These values remained within the expected operating ranges, and no alert was raised."
            )
            if later:
                later_metrics = later["metrics"]
                description += (
                    f"\n\nFive minutes later, telemetry {later['id']} changed to warning status: temperature rose "
                    f"to {later_metrics['curing_temperature']} C, pressure reached {later_metrics['curing_pressure']} bar, "
                    f"and cycle time increased to {later_metrics['cycle_time']} minutes. The rapid change suggests a developing "
                    f"curing-process deviation involving heater regulation, sensor calibration, pressure control, or mold sealing."
                    f"\n\nAssessment: the selected issue is not itself anomalous, but it is an important baseline for the warning that follows. "
                    f"Inspect the heating and pressure-control systems and continue trend monitoring."
                )
        dialog = QMessageBox(self)
        dialog.setWindowTitle("Machine 001 issue description")
        dialog.setIcon(QMessageBox.Icon.Information)
        dialog.setText(PRIORITY_ISSUE_ID)
        dialog.setDetailedText(description)
        dialog.setInformativeText(description)
        dialog.setStandardButtons(QMessageBox.StandardButton.Ok)
        dialog.exec()


if __name__ == "__main__":
    app = QApplication(sys.argv)
    window = VolvoMAD()
    window.show()
    sys.exit(app.exec())
