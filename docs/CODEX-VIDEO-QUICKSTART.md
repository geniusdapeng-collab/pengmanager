# Native video integration

PengManager includes the source for its video supervisor and host adapters. The public release includes selected support files for the host, while the complete native engine installation is provided separately in deployments that use it. WorkLoom's public upstream is [WorkLoom-video-edit](https://github.com/geniusdapeng-collab/WorkLoom-video-edit).

The native supervisor requires a compatible engine in `engines/video-edit`, a release-pinned inventory, private workspace storage and its authorized provider environment. A generic git clone of the upstream engine does not satisfy the host's inventory and integration checks. Read the [runtime source](../src/video-runtime/) when integrating a compatible distribution.

The demo runs the host without starting the native engine. With a complete installation, use `pnpm video:doctor` before enabling any native operations. Report missing setup as such. Production must follow the original job and read back the actual output, applied processing and technical checks before reporting delivery.
