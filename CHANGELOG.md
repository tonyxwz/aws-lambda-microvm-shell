# Changelog

## [0.1.0] - 2026-11-21

Initial release.

- Replace pi's `bash`, `read`, `write`, `edit`, `ls`, `find`, `grep` tools and user `!` commands with implementations
  that run inside a dedicated AWS Lambda MicroVM (`/workspace`); the agent has no access to the local machine.
- `/mvm init`: create the S3 bucket, IAM build role and MicroVM image (remote build of the bundled Dockerfile:
  Amazon Linux 2023 + Node.js LTS) and save it to `extensionSettings.microvmArn` / `microvmImage`.
- Sharing with user approval: `/mvm-upload`, `/mvm-download`, and the `request_upload` / `request_download` tools.
- Lifecycle: one MicroVM per session, reattached on `pi --resume`, auto-suspend when idle, `/mvm status|suspend|resume|terminate|new`.
