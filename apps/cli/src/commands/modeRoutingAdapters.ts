import {
  buildModeAndModelCommandRoutingDeps,
  buildModeFeatureCommandRoutingDeps,
} from './commandRoutingDepBuilders.js';

type ModeAndModelRoutingOptionsFromMain = Parameters<typeof buildModeAndModelCommandRoutingDeps>[0];
type ModeFeatureRoutingOptionsFromMain = Parameters<typeof buildModeFeatureCommandRoutingDeps>[0];

export type ModeAndModelRoutingDepsFromMain = ReturnType<typeof buildModeAndModelCommandRoutingDeps>;
export type ModeFeatureRoutingDepsFromMain = ReturnType<typeof buildModeFeatureCommandRoutingDeps>;

export function buildModeAndModelCommandRoutingDepsFromMain(
  params: ModeAndModelRoutingOptionsFromMain,
): ModeAndModelRoutingDepsFromMain {
  return buildModeAndModelCommandRoutingDeps(params);
}

export function buildModeFeatureCommandRoutingDepsFromMain(
  params: ModeFeatureRoutingOptionsFromMain,
): ModeFeatureRoutingDepsFromMain {
  return buildModeFeatureCommandRoutingDeps(params);
}
