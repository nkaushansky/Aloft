/* eslint-disable */
export interface AudioFrame { airspeed: number; agl: number; alt: number; lift: number; climb: number; beat: number; beatPhase: number; touch: number; overWater: boolean; mode: 'air' | 'ground' | 'leap'; companions: number; progress: number; night: number; inCloud: number; forest: number; water: number; wind: number; storm: number; bank: number }
export class AudioEngine {
  readonly ready = false;
  start() {} setLand(..._a: any[]) {} setScene(..._a: any[]) {} update(..._a: any[]) {} call(..._a: any[]) {} answer(..._a: any[]) {} companionCall(..._a: any[]) {} feather(..._a: any[]) {} companionJoin(..._a: any[]) {} discover() {} bell() {} whale() {} thunder(..._a: any[]) {} splash(..._a: any[]) {} land(..._a: any[]) {} leap() {} ui(..._a: any[]) {} setVolumes(..._a: any[]) {} setMuted(..._a: any[]) {} suspend() {} resume() {}
}
