import * as cdk from 'aws-cdk-lib';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import type { DecoupledTagKeys } from '../constants/decoupled.ts';

export interface DecoupledResourceFinderProps {
  /** The tag key to filter by (e.g., 'Backup' or 'Monitor') */
  tagKey: DecoupledTagKeys;
  /** The tag value to match. Defaults to 'true' */
  tagValue?: string;
  /** Optional AWS resource type filters (e.g., ['s3', 'dynamodb']) */
  resourceTypeFilters?: string[];
}

export class DecoupledResourceFinder extends Construct {
  public readonly resourceArns: string[];
  constructor(scope: Construct, id: string, props: DecoupledResourceFinderProps) {
    super(scope, id);
    const tagValue = props.tagValue ?? 'true';
    // Query AWS Resource Groups Tagging API during secondary pipeline execution
    const getResourcesCall = new cr.AwsCustomResource(this, 'GetTaggedResources', {
      onCreate: {
        service: 'ResourceGroupsTaggingAPI',
        action: 'getResources',
        parameters: {
          TagFilters: [
            {
              Key: props.tagKey,
              Values: [tagValue],
            },
          ],
          ...(props.resourceTypeFilters && {
            ResourceTypeFilters: props.resourceTypeFilters,
          }),
        },
        physicalResourceId: cr.PhysicalResourceId.of(
          `decoupled-finder-${props.tagKey}-${tagValue}-${Date.now()}`,
        ),
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
        resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE,
      }),
    });
    // Extract list of matching ARNs from the API response
    this.resourceArns = cdk.Token.asList(
      getResourcesCall.getResponseFieldReference('ResourceTagMappingList.ResourceARN'),
    );
  }
}
