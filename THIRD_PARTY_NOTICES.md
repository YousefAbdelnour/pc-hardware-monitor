# Third-Party Notices

This project bundles third-party software inside the packaged desktop app and the custom sensor-reader helper.

## LibreHardwareMonitor / LibreHardwareMonitorLib

- Project: LibreHardwareMonitor
- Included component: `LibreHardwareMonitorLib.dll`
- Use in this repository: bundled inside the custom `monitor-sensor-reader` helper
- Upstream: https://github.com/LibreHardwareMonitor/LibreHardwareMonitor
- License: Mozilla Public License 2.0 (MPL-2.0)

Included license texts:

- [licenses/LibreHardwareMonitor/LICENSE.txt](./licenses/LibreHardwareMonitor/LICENSE.txt)
- [licenses/LibreHardwareMonitor/THIRD-PARTY-NOTICES.txt](./licenses/LibreHardwareMonitor/THIRD-PARTY-NOTICES.txt)

This project does not claim ownership of LibreHardwareMonitor. The packaged app does not ship the upstream LibreHardwareMonitor GUI. It ships a custom headless sensor reader that depends on `LibreHardwareMonitorLib.dll`, and that library remains subject to its original license terms and notices.
