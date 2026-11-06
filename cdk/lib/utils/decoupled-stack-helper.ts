import * as cdk from 'aws-cdk-lib';
import type { IConstruct } from 'constructs';
import { DecoupledTagKeys } from '../constants/decoupled';

export const DecoupledStackHelper = {
  tagForBackup(scope: IConstruct, enabled = true): void {
    cdk.Tags.of(scope).add(DecoupledTagKeys.Backup, String(enabled));
  },
  tagForMonitoring(scope: IConstruct, enabled = true): void {
    cdk.Tags.of(scope).add(DecoupledTagKeys.Monitor, String(enabled));
  },
  /**
   * Extract tagged CfnResources from the construct tree by inspecting
   * the CDK TagManager rendered tags during synthesis phase.
   */
  getTaggedResources(scope: IConstruct, tagKey: DecoupledTagKeys): cdk.CfnResource[] {
    const matchedResources: cdk.CfnResource[] = [];
    cdk.Aspects.of(scope).add({
      visit(node: IConstruct) {
        if (cdk.CfnResource.isCfnResource(node) && cdk.TagManager.isTaggable(node)) {
          const rendered = node.tags.renderedTags;
          if (
            Array.isArray(rendered) &&
            rendered.some((t) => t.key === tagKey && t.value === 'true')
          ) {
            matchedResources.push(node);
          }
        }
      },
    });
    return matchedResources;
  },
};
