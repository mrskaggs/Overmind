// SpawnGroup provides a decentralized method of spawning creeps from multiple nearby colonies. Use cases include
// incubation, spawning large combat groups, etc.

import {Hatchery, SpawnRequest} from '../hiveClusters/hatchery';
import {Mem} from '../memory/Memory';
import {getAllColonyRooms, getCacheExpiration, minBy, onPublicServer} from '../utilities/utils';
import {Pathing} from '../movement/Pathing';
import {bodyCost} from '../creepSetups/CreepSetup';
import {log} from '../console/log';
import {profile} from '../profiler/decorator';
import {Colony} from '../Colony';

interface SpawnGroupMemory {
	colonies: string[];
	distances: { [colonyName: string]: number };
	routes: { [colonyName: string]: { [roomName: string]: boolean } };
	// paths: { [colonyName: string]: { startPos: RoomPosition, path: string[] } }
	// tick: number;
	expiration: number,
}

const SpawnGroupMemoryDefaults: SpawnGroupMemory = {
	colonies  : [],
	distances : {},
	routes    : {},
	// paths    : {},
	expiration: 0,
};


const MAX_LINEAR_DISTANCE = 10; // maximum linear distance to search for ANY spawn group
const MAX_PATH_DISTANCE = 600;	// maximum path distance to consider for ANY spawn group
const DEFAULT_RECACHE_TIME = onPublicServer() ? 2000 : 1000;

const defaultSettings: SpawnGroupSettings = {
	maxPathDistance: 250,		// override default path distance
	requiredRCL    : 7,
	flexibleEnergy : true,
};

export interface SpawnGroupSettings {
	maxPathDistance: number,	// maximum path distance colonies can spawn creeps to
	requiredRCL: number,		// required RCL of colonies to contribute
	flexibleEnergy: boolean,	// whether to enforce that only the largest possible creeps are spawned
}

export interface SpawnGroupInitializer {
	ref: string;
	room: Room | undefined;
	pos: RoomPosition;
}

@profile
export class SpawnGroup {

	memory: SpawnGroupMemory;
	requests: SpawnRequest[];
	roomName: string;
	colonyNames: string[];
	energyCapacityAvailable: number;
	ref: string;
	settings: SpawnGroupSettings;
	stats: {
		avgDistance: number;
	};

	constructor(initializer: SpawnGroupInitializer, settings: Partial<SpawnGroupSettings> = {}) {
		this.roomName = initializer.pos.roomName;
		// this.room = initializer.room;
		this.memory = Mem.wrap(Memory.rooms[this.roomName], 'spawnGroup', SpawnGroupMemoryDefaults);
		this.ref = initializer.ref + ':SG';
		this.stats = {
			avgDistance: (_.sum(this.memory.distances) / _.keys(this.memory.distances).length) || 100,
		};
		this.requests = [];
		this.settings = _.defaults(settings, defaultSettings) as SpawnGroupSettings;
		if (Game.time >= this.memory.expiration) {
			this.recalculateColonies();
		}
		// Compute stats
		this.colonyNames = _.filter(this.memory.colonies,
									roomName => this.memory.distances[roomName] <= this.settings.maxPathDistance &&
												Game.rooms[roomName] && Game.rooms[roomName].my &&
												Game.rooms[roomName].controller!.level >= this.settings.requiredRCL);
		this.energyCapacityAvailable = _.max(_.map(this.colonyNames,
												   roomName => Game.rooms[roomName].energyCapacityAvailable));
		Overmind.spawnGroups[this.ref] = this;
	}

	/* Refresh the state of the spawnGroup; called by the Overmind object. */
	refresh() {
		this.memory = Mem.wrap(Memory.rooms[this.roomName], 'spawnGroup', SpawnGroupMemoryDefaults);
		this.requests = [];
	}

	private recalculateColonies() { // don't use settings when recalculating colonies as spawnGroups share memory
		let colonyRoomsInRange = _.filter(getAllColonyRooms(), room =>
			Game.map.getRoomLinearDistance(room.name, this.roomName) <= MAX_LINEAR_DISTANCE);
		let colonies = [] as string[];
		let routes = {} as { [colonyName: string]: { [roomName: string]: boolean } };
		// let paths = {} as { [colonyName: string]: { startPos: RoomPosition, path: string[] } };
		let distances = {} as { [colonyName: string]: number };
		for (let colonyRoom of colonyRoomsInRange) {
			let spawn = colonyRoom.spawns[0];
			if (spawn) {
				let route = Pathing.findRoute(colonyRoom.name, this.roomName);
				let path = Pathing.findPathToRoom(spawn.pos, this.roomName, {route: route});
				if (route && !path.incomplete && path.path.length <= MAX_PATH_DISTANCE) {
					colonies.push(colonyRoom.name);
					routes[colonyRoom.name] = route;
					// paths[room.name] = path.path;
					distances[colonyRoom.name] = path.path.length;
				}
			}
		}
		this.memory.colonies = colonies;
		this.memory.routes = routes;
		// this.memory.paths = TODO
		this.memory.distances = distances;
		this.memory.expiration = getCacheExpiration(DEFAULT_RECACHE_TIME, 25);
	}

	enqueue(request: SpawnRequest): void {
		this.requests.push(request);
	}

	/* SpawnGroup.init() must be called AFTER all hatcheries have been initialized */
	init(): void {
		// Most initialization needs to be done at init phase because colonies are still being constructed earlier
		const colonies = _.compact(_.map(this.colonyNames, name => Overmind.colonies[name])) as Colony[];
		const hatcheries = _.compact(_.map(colonies, colony => colony.hatchery)) as Hatchery[];
		const distanceTo = (hatchery: Hatchery) => this.memory.distances[hatchery.pos.roomName] + 25;
		// Enqueue all requests to the hatchery with least expected wait time that can spawn full-size creep
		for (let request of this.requests) {
			let maxCost = bodyCost(request.setup.generateBody(this.energyCapacityAvailable));
			let okHatcheries = _.filter(hatcheries,
										hatchery => hatchery.room.energyCapacityAvailable >= maxCost);
			// || this.settings.flexibleEnergy);
			let bestHatchery = minBy(okHatcheries, hatchery => hatchery.nextAvailability + distanceTo(hatchery));
			if (bestHatchery) {
				bestHatchery.enqueue(request);
			} else {
				log.warning(`Could not enqueue creep ${request.setup.role} from spawnGroup in ${this.roomName}`);
			}
		}
	}

	run(): void {
		// Nothing goes here
	}

}
