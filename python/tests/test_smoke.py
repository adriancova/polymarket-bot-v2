"""WP-010 smoke test: the uv workspace and package placeholders import cleanly."""

import calibration
import reports
import research


def test_placeholder_packages_import() -> None:
    assert research.PACKAGE_NAME == "research"
    assert calibration.PACKAGE_NAME == "calibration"
    assert reports.PACKAGE_NAME == "reports"
