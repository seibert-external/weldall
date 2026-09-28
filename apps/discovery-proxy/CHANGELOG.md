# @weldall/discovery-proxy

## 0.1.1

### Patch Changes

- aa02432: Publish the discovery proxy as a Docker image. Each `@weldall/discovery-proxy` release is now built, tested against a controlled TLS upstream, and published to Docker Hub as `x.y.z`, `x.y`, `latest` and the commit SHA.

## 0.1.0

### Minor Changes

- 3d7f7b7: Version the discovery proxy as its own release unit, independent of the Weldall server. `changeset publish` creates a `@weldall/discovery-proxy@x.y.z` Git tag and GitHub release, and the Docker image release builds from that tag.
