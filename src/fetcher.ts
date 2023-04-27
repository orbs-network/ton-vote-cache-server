import * as TonVoteSdk from "ton-vote-contracts-sdk";
import { TonClient, TonClient4 } from "ton";
import { State } from "./state";
import { MetadataArgs, DaoRoles } from "ton-vote-contracts-sdk";
import { ProposalsByState } from "./types";


// import {TxData, VotingPower, Votes, ProposalResults, ProposalInfo} from "./types";
// import * as Logger from './logger';

const DAOS_BATCH_SIZE = 100;
const PROPOSALS_BATCH_SIZE = 100;

const UPDATE_DAOS_BATCH_SIZE = 35;
const PROPOSAL_METADATA_BATCH_SIZE = 35;


export class Fetcher {

    private client!: TonClient;
    private client4!: TonClient4;
    private state: State;
    private fetchUpdate: {[proposalAddress: string]: number} = {};
    finished: boolean = true;
    proposalsByState: ProposalsByState = {pending: new Set(), active: new Set(), ended: new Set()};

    constructor(state: State) {
        this.state = state;
    }

    async init() {
        this.client = await TonVoteSdk.getClientV2();
        this.client4 = await TonVoteSdk.getClientV4();

        console.log('starting with masterchainInfo: ', await this.client.getMasterchainInfo())
        await this.updateRegistry();
    }

    async updateRegistry() {
        const registry = await TonVoteSdk.getRegistry(this.client);
        console.log(`registry: `, registry);
        
        this.state.setRegistry(registry);
    }

    async updateDaos() {
        
        console.log(`updateDaos started`);
        
        const daosData = this.state.getDaosData()

        console.log(`daosData.nextDaoId = ${daosData.nextDaoId}`);
        
        let newDaos = await TonVoteSdk.getDaos(this.client, daosData.nextDaoId, DAOS_BATCH_SIZE, 'asc');
        
        if (newDaos.daoAddresses.length == 0) return;

        console.log(`${newDaos.daoAddresses.length} new daos will be added: `, newDaos.daoAddresses);

        const batchSize = UPDATE_DAOS_BATCH_SIZE; 
        const daos = newDaos.daoAddresses;
        const chunks = [];
        for (let i = 0; i < daos.length; i += batchSize) {
          chunks.push(daos.slice(i, i + batchSize));
        }
        
        for (const chunk of chunks) {
          await Promise.all(chunk.map(async (daoAddress) => {
            const daoMetadata = await TonVoteSdk.getDaoMetadata(this.client, daoAddress);
            const daoRoles = await TonVoteSdk.getDaoRoles(this.client, daoAddress);
            const daoId = await TonVoteSdk.getDaoIndex(this.client, daoAddress);
        
            daosData.daos.set(daoAddress, {
              daoAddress: daoAddress,
              daoId: daoId,
              daoMetadata: daoMetadata,
              daoRoles: daoRoles,
              nextProposalId: 0,
              daoProposals: []
            });
          }));
        }
        
        daosData.nextDaoId = newDaos.endDaoId;
        const sortedDaos = new Map<string, {
            daoAddress: string,
            daoId: number,
            daoMetadata: MetadataArgs,
            daoRoles: DaoRoles,
            nextProposalId: number,
            daoProposals: string[]
        }>(Array.from(daosData.daos.entries()).sort((a, b) => a[1].daoId - b[1].daoId));
                
        daosData.daos = sortedDaos;

        this.state.setDaosData(daosData); 
    }
    
    async updateDaosProposals() {

        console.log(`updateDaosProposals started`);

        const daosData = this.state.getDaosData()
        const proposalsData = this.state.getProposalsData();
        console.log(`updateDaosProposals: `, proposalsData);

        await Promise.all(Array.from(daosData.daos.entries()).map(async ([daoAddress, daoData]) => {
            console.log(`fetching proposals for dao ${daoAddress}`);
            
            const newProposals = await TonVoteSdk.getDaoProposals(this.client, daoAddress, daoData.nextProposalId, PROPOSALS_BATCH_SIZE, 'asc');
            
            if (newProposals.proposalAddresses) {
        
                console.log(`address ${daoAddress}: ${newProposals.proposalAddresses?.length} newProposals: `, newProposals);
        
                const batchSize = PROPOSAL_METADATA_BATCH_SIZE;

                const proposalAddresses = newProposals.proposalAddresses;
                const chunks = [];
                for (let i = 0; i < proposalAddresses.length; i += batchSize) {
                  chunks.push(proposalAddresses.slice(i, i + batchSize));
                }
                
                for (const chunk of chunks) {
                  await Promise.all(chunk.map(async (proposalAddress) => {
                    console.log(`fetching info from proposal at address ${proposalAddress}`);
                    const proposalMetadata = await TonVoteSdk.getProposalMetadata(this.client, this.client4, proposalAddress);
                
                    proposalsData.set(proposalAddress, {
                      daoAddress: daoAddress,
                      proposalAddress: proposalAddress,
                      metadata: proposalMetadata
                    });
                
                    this.proposalsByState.pending = this.proposalsByState.pending.add(proposalAddress);
                
                    if (proposalMetadata.votingPowerStrategy == TonVoteSdk.VotingPowerStrategy.NftCcollection) {
                      this.state.addProposalAddrToMissingNftCollection(proposalAddress)
                    }
                  }));
                }
                        
                daoData.nextProposalId = newProposals.endProposalId;

                const sortedProposals = newProposals.proposalAddresses!.sort((a, b) => proposalsData.get(a)?.metadata.id! - proposalsData.get(b)?.metadata.id!);
                daoData.daoProposals = [...daoData.daoProposals, ...sortedProposals];
                daosData.daos.set(daoAddress, daoData);
        
            } else {
                console.log(`no proposals found for dao ${daoAddress}`);
            }
        }));

        this.state.setProposalsData(proposalsData);             
        this.state.setDaosData(daosData);             
    }

    updateProposalsState() {

        console.log(`updateProposalsState started`);

        const proposalsData = this.state.getProposalsData();
        const now = Date.now() / 1000;

        this.proposalsByState.pending.forEach(proposalAddress => {
            
            const metadata = proposalsData.get(proposalAddress)?.metadata;

            if (!metadata) {
                console.log(`unexpected error: could not find metadata at propsal ${proposalAddress}`);
                return;                
            }

            if (metadata.proposalStartTime <= now && metadata.proposalEndTime >= now) {                
                this.proposalsByState.active.add(proposalAddress);
                this.proposalsByState.pending.delete(proposalAddress);
                console.log(`proposal ${proposalAddress} was moved to active proposals`);
            }

            else if (metadata.proposalStartTime <= now && metadata.proposalEndTime <= now) {
                this.proposalsByState.ended.add(proposalAddress);
                this.proposalsByState.pending.delete(proposalAddress);
                console.log(`proposal ${proposalAddress} was moved to ended proposals`);
            }
        }); 

        this.proposalsByState.active.forEach(proposalAddress => {

            const metadata = proposalsData.get(proposalAddress)?.metadata;

            if (!metadata) {
                console.log(`unexpected error: could not find metadata at propsal ${proposalAddress}`);
                return;                
            }

            if (metadata.proposalStartTime <= now && metadata.proposalEndTime <= now) {
                this.proposalsByState.ended.add(proposalAddress);
                this.proposalsByState.pending.delete(proposalAddress);
                console.log(`proposal ${proposalAddress} was moved to ended proposals`);
            }

        }); 

        console.log(this.proposalsByState);
        
    }

    async updatePendingProposalData() {
        
        console.log(`updatePendingProposalData started`);
        
        const proposalsData = this.state.getProposalsData();
        const nftHolders = this.state.getNftHolders();

        const proposalAddrWithMissingNftCollection = this.state.getProposalAddrWithMissingNftCollection();

        await Promise.all([...proposalAddrWithMissingNftCollection].map(async (proposalAddr) => {
            let proposalData = proposalsData.get(proposalAddr);

            if (!(proposalAddr in nftHolders)) {
                console.log(`fetching nft items data for proposalAddr ${proposalAddr}`);
                nftHolders[proposalAddr] = await TonVoteSdk.getAllNftHolders(this.client4, proposalData!.metadata);
                this.state.setNftHolders(proposalAddr, nftHolders[proposalAddr]);    
            } else {
                console.log(`nft items already exist in nftHolder for collection ${proposalAddr}, skiping fetching data proposalAddr ${proposalAddr}`);
            }

            console.log(`updatePendingProposalData: updating nft holders for proposal ${proposalAddr}: `, nftHolders[proposalAddr]);
            this.state.deleteProposalAddrFromMissingNftCollection(proposalAddr);
        }));     
    }

    async updateProposalVotingData() {

        console.log(`updateProposalVotingData started`);

        const proposalsData = this.state.getProposalsData();
        
        await Promise.all([...this.proposalsByState.active, ...this.proposalsByState.ended].map(async (proposalAddr) => {

            if (this.proposalsByState.ended.has(proposalAddr) && (proposalAddr in this.fetchUpdate)) {
                return;
            }

            let proposalData = proposalsData.get(proposalAddr);
            let proposalVotingData = proposalData!.votingData;

            if (!proposalData) {
                console.log(`unexpected error: proposalAddr ${proposalAddr} was not found on proposalData`);
                return;
            }

            if (!proposalVotingData) {
                proposalVotingData = {
                    txData: {allTxns: [], maxLt: undefined},
                    votingPower: {},
                    votes: {},
                    proposalResult: {yes: 0, no: 0, abstain: 0, totalWeight: '0'}
                }
            }

            const newTx = await TonVoteSdk.getTransactions(this.client, proposalAddr, proposalVotingData.txData.maxLt);

            if (newTx.maxLt == proposalVotingData.txData.maxLt) {
                console.log(`Nothing to fetch for proposal at ${proposalAddr}`);
                this.fetchUpdate[proposalAddr] = Date.now();
                return;
            }
            
            newTx.allTxns = [...newTx.allTxns, ...proposalVotingData.txData.allTxns]
            // TODO: getAllVotes - use only new tx not all of them
            let newVotes = TonVoteSdk.getAllVotes(newTx.allTxns, proposalData.metadata);
            
            const nftItmesHolders = this.state.getNftHolders();
            console.log('nftItmesHolders: ', nftItmesHolders);
            
            let newVotingPower = await TonVoteSdk.getVotingPower(this.client4, proposalData.metadata, newTx.allTxns, proposalVotingData.votingPower, proposalData.metadata.votingPowerStrategy, nftItmesHolders[proposalAddr]);
            let newProposalResults = TonVoteSdk.getCurrentResults(newTx.allTxns, newVotingPower, proposalData.metadata);

            proposalVotingData.proposalResult = newProposalResults;
            proposalVotingData.txData = newTx;
            proposalVotingData.votes = newVotes;
            proposalVotingData.votingPower = newVotingPower;

            proposalData.votingData = proposalVotingData;
            proposalsData.set(proposalAddr, proposalData!);

            console.log('setting new proposalData: ', proposalData);
            
            this.state.setProposalData(proposalAddr, proposalData);
            this.fetchUpdate[proposalAddr] = Date.now();
        }));
          
    }

    async run() {

        try {

            if (!this.finished) {
                console.log('skipping run, still featching ...');            
                return;
            }

            this.finished = false;

            await this.updateDaos();
            
            await this.updateDaosProposals();

            this.updateProposalsState();

            await this.updatePendingProposalData();

            await this.updateProposalVotingData();
            
            this.finished = true;
            this.state.setUpdateTime()

        } catch (error) {

            this.finished = true;            
            console.log('unexpected error: ', (error as Error).stack);
        }
    }

    getFetchUpdateTime(proposalAddress: string) {
        return this.fetchUpdate[proposalAddress];
    }
}